// Starts the fake model server for manual and end-to-end testing:
// node serve-fake-model.ts [port] [api key]
import { startFakeModelServer } from './fake-model-server.ts';

const port = Number(process.argv[2] ?? 11434);
const server = await startFakeModelServer({
  port,
  models: ['qwen3:0.6b', 'llama3.2:1b'],
  reasoning: ['The user wants a short list.', ' I will answer in Markdown.'],
  answer: [
    'Here are **three** local-first tools:\n\n',
    '1. Ollama\n',
    '2. LM Studio\n',
    '3. llama.cpp\n',
  ],
  chunkDelayMs: 120,
  ...(process.argv[3] ? { apiKey: process.argv[3] } : {}),
});
console.log(`Fake model server listening at ${server.baseUrl}`);
