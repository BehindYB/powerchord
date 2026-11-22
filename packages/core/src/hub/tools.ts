import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TASK_STATUSES, type HubStore, type HubTask } from './store.ts';

/*
 * Tools of the PowerChord MCP hub. They share context between agents and the user; none of them
 * hands an agent instructions on PowerChord's behalf (docs/COMPLIANCE.md, "PowerChord MCP server").
 */

export interface LocalModelInfo {
  server: string;
  models: string[];
}

export interface LocalModelAnswer {
  server: string;
  model: string;
  text: string;
}

/** Access to the user's local and self-hosted model servers. */
export interface LocalModelGateway {
  listModels(): Promise<LocalModelInfo[]>;
  complete(request: {
    prompt: string;
    system?: string;
    model?: string;
    maxTokens?: number;
  }): Promise<LocalModelAnswer>;
}

/** The private memory of PowerChord projects, found by project folder. */
export interface ProjectMemoryGateway {
  /** Null when no PowerChord project has this folder. */
  read(folder: string): Promise<{ project: string; memory: string } | null>;
  remember(folder: string, note: string, author: string): Promise<{ project: string }>;
}

export interface HubContext {
  store: HubStore;
  models: LocalModelGateway;
  memory?: ProjectMemoryGateway;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

async function guarded(action: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await action();
  } catch (error) {
    return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

function taskOverview(task: HubTask) {
  return { id: task.id, title: task.title, status: task.status, updatedBy: task.updatedBy };
}

const statusSchema = z.enum(TASK_STATUSES as [string, ...string[]]);

/**
 * Registers the hub tools on an MCP server instance for one client. `projectFolder` is the working
 * folder of a session PowerChord drives, used when a memory tool is called without a folder.
 */
export function registerHubTools(
  server: McpServer,
  hub: HubContext,
  author: string,
  projectFolder: string | null = null,
): void {
  server.registerTool(
    'list_local_models',
    {
      description:
        "Lists the language models available on the user's own local or self-hosted servers.",
      inputSchema: {},
    },
    () => guarded(async () => json(await hub.models.listModels())),
  );

  server.registerTool(
    'ask_local_model',
    {
      description:
        "Sends a self-contained prompt to a language model running on the user's own hardware and " +
        'returns its answer. Useful for delegating summarizing, drafting, translating, classifying ' +
        'or bulk text work. The local model has no access to files or tools and sees only the prompt.',
      inputSchema: {
        prompt: z.string().min(1).describe('Complete prompt, including any text the model needs.'),
        system: z.string().optional().describe('Optional system instructions.'),
        model: z
          .string()
          .optional()
          .describe('Model id from list_local_models; the user default is used when omitted.'),
        max_tokens: z.number().int().positive().max(32_000).optional(),
      },
    },
    (args) =>
      guarded(async () => {
        const answer = await hub.models.complete({
          prompt: args.prompt,
          ...(args.system !== undefined ? { system: args.system } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.max_tokens !== undefined ? { maxTokens: args.max_tokens } : {}),
        });
        return text(`[${answer.model} on ${answer.server}]\n\n${answer.text}`);
      }),
  );

  server.registerTool(
    'list_tasks',
    {
      description: 'Lists the tasks the user and agents share in PowerChord.',
      inputSchema: { status: statusSchema.optional() },
    },
    (args) =>
      guarded(async () => {
        const { tasks } = await hub.store.snapshot();
        return json(
          tasks.filter((task) => !args.status || task.status === args.status).map(taskOverview),
        );
      }),
  );

  server.registerTool(
    'get_task',
    {
      description: 'Returns a shared task with its description and latest summary.',
      inputSchema: { id: z.string() },
    },
    (args) =>
      guarded(async () => {
        const task = (await hub.store.snapshot()).tasks.find((entry) => entry.id === args.id);
        if (!task) throw new Error(`No task with id ${args.id}`);
        return json(task);
      }),
  );

  server.registerTool(
    'add_task',
    {
      description: 'Adds a shared task, for example a follow-up for the user or another agent.',
      inputSchema: { title: z.string().min(1), description: z.string().optional() },
    },
    (args) =>
      guarded(async () =>
        json(
          await hub.store.addTask(
            {
              title: args.title,
              ...(args.description !== undefined ? { description: args.description } : {}),
            },
            author,
          ),
        ),
      ),
  );

  server.registerTool(
    'update_task',
    {
      description:
        "Updates a shared task's status and records a summary of the progress or result.",
      inputSchema: {
        id: z.string(),
        status: statusSchema.optional(),
        summary: z.string().optional(),
      },
    },
    (args) =>
      guarded(async () =>
        json(
          await hub.store.updateTask(
            args.id,
            {
              ...(args.status !== undefined ? { status: args.status as HubTask['status'] } : {}),
              ...(args.summary !== undefined ? { summary: args.summary } : {}),
            },
            author,
          ),
        ),
      ),
  );

  server.registerTool(
    'list_notes',
    {
      description: 'Lists the notes the user and agents share in PowerChord.',
      inputSchema: {},
    },
    () =>
      guarded(async () =>
        json(
          (await hub.store.snapshot()).notes.map((note) => ({
            id: note.id,
            title: note.title,
            updatedBy: note.updatedBy,
          })),
        ),
      ),
  );

  server.registerTool(
    'read_note',
    { description: 'Returns a shared note.', inputSchema: { id: z.string() } },
    (args) =>
      guarded(async () => {
        const note = (await hub.store.snapshot()).notes.find((entry) => entry.id === args.id);
        if (!note) throw new Error(`No note with id ${args.id}`);
        return json(note);
      }),
  );

  server.registerTool(
    'write_note',
    {
      description:
        'Creates a shared note, or replaces an existing one when an id is given. Use it for ' +
        'decisions, plans and findings that the user or other agents should see.',
      inputSchema: { title: z.string().min(1), content: z.string(), id: z.string().optional() },
    },
    (args) =>
      guarded(async () =>
        json(
          await hub.store.saveNote(
            {
              title: args.title,
              content: args.content,
              ...(args.id !== undefined ? { id: args.id } : {}),
            },
            author,
          ),
        ),
      ),
  );

  const memory = hub.memory;
  if (!memory) return;
  const folderFor = (folder: string | undefined): string => {
    const value = folder ?? projectFolder;
    if (!value) throw new Error('Pass the absolute path of the project folder.');
    return value;
  };

  server.registerTool(
    'read_project_memory',
    {
      description:
        'Reads the private memory the user keeps in PowerChord for a project: notes about the ' +
        'project, preferences and decisions to keep in mind. Read it when starting work on a project.',
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe('Absolute path of the project folder; defaults to the current project'),
      },
    },
    (args) =>
      guarded(async () => {
        const result = await memory.read(folderFor(args.folder));
        if (!result) throw new Error('This folder is not a PowerChord project.');
        return text(
          result.memory.trim()
            ? `Memory of ${result.project}:\n\n${result.memory}`
            : `The memory of ${result.project} is empty.`,
        );
      }),
  );

  server.registerTool(
    'remember',
    {
      description:
        'Adds a short note to the private memory of a project in PowerChord, for later sessions ' +
        'with any agent. Use it for lasting facts the user wants remembered, such as preferences, ' +
        'conventions or decisions, not for progress updates.',
      inputSchema: {
        note: z.string().min(1).describe('One self-contained fact, in a sentence or two'),
        folder: z
          .string()
          .optional()
          .describe('Absolute path of the project folder; defaults to the current project'),
      },
    },
    (args) =>
      guarded(async () => {
        const { project } = await memory.remember(folderFor(args.folder), args.note, author);
        return text(`Added to the memory of ${project}.`);
      }),
  );
}
