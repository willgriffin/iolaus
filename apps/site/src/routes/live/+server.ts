import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Liveness is process-only. Provider/database readiness belongs to /health so
// an external outage removes this replica from service without restart churn.
export const GET: RequestHandler = () => json({ ok: true }, { status: 200 });
