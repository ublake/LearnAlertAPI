import worker from '../src/index.js';
export default { ...worker, fetch(request, env, ctx) {
  return worker.fetch(request, { ALLOW_UNAUTHENTICATED_AI: 'true', AI_LIMITS_DISABLED: 'true', ...env }, ctx);
} };
