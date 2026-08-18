// Renders judge/judge.yml's template (bind-mounted read-only into this
// container at /judge-config/judge.yml.template) into a real config at
// /judge-config/judge.yml, substituting this container's own JUDGE_NAME and
// JUDGE_TOKEN — see judge/entrypoint.sh and the comment at the top of
// judge/judge.yml.
import { readFileSync, writeFileSync } from 'node:fs';

const name = process.env.JUDGE_NAME;
const token = process.env.JUDGE_TOKEN;
if (!name || !token) {
  console.error(
    JSON.stringify({ msg: 'render-config: JUDGE_NAME and JUDGE_TOKEN are both required' }),
  );
  process.exit(1);
}

const template = readFileSync('/judge-config/judge.yml.template', 'utf8');
// Plain string substitution, not a templating engine: exactly two
// placeholders, both filled from this same container's own environment —
// never from anything an archive or an upstream service supplies.
const rendered = template.replaceAll('__JUDGE_NAME__', name).replaceAll('__JUDGE_TOKEN__', token);

// 0o600: this directory (/judge-config) is otherwise only readable by the
// `judge` user that wrote it, but the credential inside deserves the same
// treatment regardless.
writeFileSync('/judge-config/judge.yml', rendered, { mode: 0o600 });
console.log(JSON.stringify({ msg: 'rendered judge.yml', id: name }));
