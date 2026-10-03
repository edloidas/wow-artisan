import { join } from 'node:path';

let built: Promise<string> | undefined;

/** One HTML file: the iframe's default CSP runs inline scripts and loads no other origin. */
export function buildView(): Promise<string> {
  built ??= bundle().catch((error: unknown) => {
    built = undefined;
    throw error;
  });
  return built;
}

async function bundle(): Promise<string> {
  const output = await Bun.build({
    entrypoints: [join(import.meta.dir, 'view.ts')],
    target: 'browser',
    minify: true,
  });
  if (!output.success) throw new AggregateError(output.logs, 'View bundle failed');
  const [script] = output.outputs;
  if (!script) throw new Error('View bundle produced no output');
  return inlineScript(
    await Bun.file(join(import.meta.dir, 'view.html')).text(),
    await script.text(),
  );
}

/** Puts `js` where the page marks it; `</script` inside it would end the inline tag early. */
export function inlineScript(html: string, js: string): string {
  const safe = js.replaceAll('</script', '<\\/script');
  return html.replace('<!-- view.js -->', () => `<script type="module">${safe}</script>`);
}
