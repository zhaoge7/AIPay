import process from 'node:process';
import { URL } from 'node:url';

const baseUrl = process.env.AIPAY_BASE_URL;
const serviceId = process.env.AIPAY_SERVICE_ID;

if (baseUrl === undefined || serviceId === undefined) {
  throw new Error('Quickstart environment is incomplete');
}

process.stdout.write(`${new URL(`/v1/a2m/resources/${serviceId}`, baseUrl).toString()}\n`);
