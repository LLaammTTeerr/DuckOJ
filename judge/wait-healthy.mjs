// Polls judge-agent's own /healthz (Task 13) until it answers or 30s pass,
// then exits 0/1 accordingly — see judge/entrypoint.sh, which execs the
// judge only after this succeeds. Node has a global `fetch` (>=18), so this
// needs no extra dependency beyond the `node` binary already copied into
// the judge image to run the agent itself.
const port = process.env.AGENT_PORT ?? '3002';
const url = `http://127.0.0.1:${port}/healthz`;
const deadline = Date.now() + 30_000;

for (;;) {
  try {
    const res = await fetch(url);
    if (res.ok) {
      await res.body?.cancel();
      console.log(JSON.stringify({ msg: 'judge-agent healthy', url }));
      process.exit(0);
    }
    await res.body?.cancel();
  } catch {
    // Not listening yet — retry until the deadline.
  }
  if (Date.now() > deadline) {
    console.error(JSON.stringify({ msg: 'judge-agent did not become healthy within 30s', url }));
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
