// Keep local application object registration in the executable worker graph.
// TaskRunner resolves persisted object types through this registry at claim time.
import '../src/lib/server/smrt.js';

export const localJobClassesRegistered = true;
