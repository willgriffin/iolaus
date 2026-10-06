// Keep local application object registration in the executable worker graph.
// TaskRunner resolves persisted object types through this registry at claim time.
import '../src/lib/server/smrt.js';
// Keep the owner-bound queued-job context seam in the standalone worker graph.
// Object methods enter it immediately before their candidate-owned work.
import '../src/lib/server/job-workspace-subject.js';
// Register the explicit candidate-owned workflow capabilities before a worker
// resolves queued methods and their PrincipalRun authorization assertions.
import '../src/lib/server/workspace-workflow-capabilities.js';

export const localJobClassesRegistered = true;
