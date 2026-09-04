import { runtimeDiagnosticsGet } from '$lib/server/runtime-diagnostics';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = runtimeDiagnosticsGet;
