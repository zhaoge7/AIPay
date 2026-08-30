import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { promisify } from 'node:util';

import ts from 'typescript';

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  },
);
const files = stdout
  .toString('utf8')
  .split('\0')
  .filter((path) => /\.(?:[cm]?[jt]sx?)$/u.test(path));
const sensitiveIdentifier =
  /(?:privatekey|sessiontoken|apikey|paymentproof|clientsecret|accesstoken)/iu;
const findings = [];

function propertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression !== undefined &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }

  return '';
}

function objectName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.expression.getText();
  if (ts.isElementAccessExpression(expression)) return expression.expression.getText();
  return '';
}

for (const path of files) {
  let sourceText;

  try {
    sourceText = await readFile(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      continue;
    }

    throw error;
  }
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function inspect(node) {
    if (ts.isCallExpression(node)) {
      const method = propertyName(node.expression).toLowerCase();
      const owner = objectName(node.expression).toLowerCase();
      const argumentText = node.arguments.map((argument) => argument.getText()).join(' ');
      const isLogSink =
        ['log', 'error', 'warn', 'info', 'debug', 'trace'].includes(method) &&
        (owner.includes('console') || owner.includes('log'));
      const isTelemetrySink =
        ['record', 'emit', 'setattribute', 'addattribute', 'capture'].includes(method) &&
        /telemetry|metric|span|trace/iu.test(owner);
      if ((isLogSink || isTelemetrySink) && sensitiveIdentifier.test(argumentText)) {
        const position = source.getLineAndCharacterOfPosition(node.getStart());
        findings.push({
          path,
          line: position.line + 1,
          sink: isLogSink ? 'log' : 'telemetry',
        });
      }
    }

    ts.forEachChild(node, inspect);
  }

  inspect(source);
}

if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(
      `${finding.path}:${String(finding.line)} sensitive identifier reaches ${finding.sink} sink\n`,
    );
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `Sensitive data audit passed for ${String(files.length)} repository source files.\n`,
  );
}
