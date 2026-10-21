import { appendFile, readFile, writeFile } from 'node:fs/promises';

const [inputPath, outputPath] = process.argv.slice(2);
try {
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const { loadApiProvider, cache } = await import('promptfoo');
  cache.disableCache();
  const provider = await loadApiProvider(input.provider.id, {
    options: { config: input.provider.config },
    basePath: input.workspace,
  });
  const response = await provider.callApi(input.prompt, {
    vars: {},
    prompt: { raw: input.prompt, label: 'shared task' },
  });
  await writeFile(outputPath, JSON.stringify(response, null, 2));
} catch (error) {
  await writeFile(outputPath, JSON.stringify({ error: String(error), stack: error.stack }));
  await appendFile(`${outputPath}.error`, `${error.stack}\n`);
  process.exitCode = 1;
}
