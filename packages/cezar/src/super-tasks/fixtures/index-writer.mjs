import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SuperTaskStore } from '../store.ts';

const [dataDir, id] = process.argv.slice(2);
const store = SuperTaskStore.open(dataDir, 'project-a');
try {
  store.createSuperTask({
    id,
    title: `Super task ${id}`,
    prompt: `Concurrent writer ${id}`,
    target: { repositoryRootSnapshot: '/repos/project-a', baseBranch: 'main' },
    workflowConfig: { roles: {} },
  });
  writeFileSync(join(dataDir, `${id}.result`), 'ok');
} catch (error) {
  writeFileSync(join(dataDir, `${id}.result`), error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
