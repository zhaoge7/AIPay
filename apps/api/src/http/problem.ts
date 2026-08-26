import { randomBytes } from 'node:crypto';

import { API_PROBLEM_MEDIA_TYPE, type ApiProblemWire } from '@aipay/contracts';
import type { FastifyReply } from 'fastify';

export function createTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function sendProblem(reply: FastifyReply, problem: Readonly<ApiProblemWire>) {
  return reply.type(API_PROBLEM_MEDIA_TYPE).status(problem.status).send(problem);
}
