import { join } from 'node:path';
import {
  instructionsPrompt,
  isLinkableInstructionFile,
  LINKABLE_INSTRUCTION_FILES,
  linkInstructionFile,
  memoryPrompt,
  ProjectMemoryStore,
  readInstructionFiles,
  SHARED_INSTRUCTIONS_FILE,
  writeSharedInstructions,
  type ProjectMemoryGateway,
} from '@powerchord/core';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { IpcChannel, type ProjectContext, type ProjectSummary } from '../shared/ipc';
import type { ProjectStore } from './projects';

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  }
}

async function confirm(
  window: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<boolean> {
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return response === 0;
}

/**
 * Project memory and instructions: the private memory PowerChord keeps per project, and the
 * instruction files in the project folder, which PowerChord writes only when the user asks.
 */
export class ProjectMemoryService {
  readonly store = new ProjectMemoryStore(join(app.getPath('userData'), 'memory'));
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  /** Access for the hub tools, which name projects by folder. */
  gateway(): ProjectMemoryGateway {
    return {
      read: async (folder) => {
        const project = this.projects.findByFolder(folder);
        return project
          ? { project: project.name, memory: await this.store.read(project.id) }
          : null;
      },
      remember: async (folder, note, author) => {
        const project = this.projects.findByFolder(folder);
        if (!project) throw new Error('This folder is not a PowerChord project.');
        await this.remember(project.id, note, author);
        return { project: project.name };
      },
    };
  }

  async remember(projectId: string, note: string, author: string): Promise<void> {
    await this.store.append(projectId, note, author);
    broadcast(IpcChannel.ProjectMemoryChanged, projectId);
  }

  private async memoryOf(folder: string): Promise<string> {
    const project = this.projects.findByFolder(folder);
    return project ? this.store.read(project.id) : '';
  }

  /** What model chats in a folder are told: its instruction files and its project memory. */
  async modelChatContext(folder: string): Promise<string> {
    const [files, memory] = await Promise.all([
      readInstructionFiles(folder),
      this.memoryOf(folder),
    ]);
    return [instructionsPrompt(files), memoryPrompt(memory)].filter(Boolean).join('\n\n');
  }

  /** What Claude Code is told on top of the CLAUDE.md files it reads by itself. */
  async agentContext(folder: string): Promise<string> {
    return memoryPrompt(await this.memoryOf(folder));
  }

  /** Saves a note to the memory of the project of a folder. */
  async rememberIn(folder: string, note: string, author: string): Promise<void> {
    const project = this.projects.findByFolder(folder);
    if (!project) throw new Error('This folder is not a PowerChord project.');
    await this.remember(project.id, note, author);
  }

  private require(projectId: unknown): ProjectSummary {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Unknown project');
    return project;
  }

  private async context(projectId: unknown): Promise<ProjectContext> {
    const project = this.require(projectId);
    const [instructions, memory] = await Promise.all([
      readInstructionFiles(project.folder),
      this.store.read(project.id),
    ]);
    return { memory, instructions };
  }

  private async saveInstructions(
    window: BrowserWindow | null,
    projectId: unknown,
    text: unknown,
  ): Promise<boolean> {
    const project = this.require(projectId);
    if (typeof text !== 'string') throw new Error('Invalid instructions');
    const files = await readInstructionFiles(project.folder);
    const exists = files.some((file) => file.name === SHARED_INSTRUCTIONS_FILE && file.exists);
    if (
      !exists &&
      !(await confirm(window, {
        type: 'question',
        buttons: ['Create file', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: `Create ${SHARED_INSTRUCTIONS_FILE}`,
        message: `Create ${SHARED_INSTRUCTIONS_FILE} in ${project.folder}?`,
        detail:
          'Codex and many other agents read this file, and PowerChord gives it to model chats. ' +
          'It is part of the project, so it can be committed and shared with everyone who works on it.',
      }))
    ) {
      return false;
    }
    await writeSharedInstructions(project.folder, text);
    return true;
  }

  private async link(
    window: BrowserWindow | null,
    projectId: unknown,
    name: unknown,
  ): Promise<boolean> {
    const project = this.require(projectId);
    if (!isLinkableInstructionFile(name)) throw new Error('Invalid file');
    const agent = LINKABLE_INSTRUCTION_FILES[name];
    const confirmed = await confirm(window, {
      type: 'question',
      buttons: ['Add import', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: `Share ${SHARED_INSTRUCTIONS_FILE} with ${agent}`,
      message: `Add "@${SHARED_INSTRUCTIONS_FILE}" to ${name}?`,
      detail: `${agent} reads ${name} and follows its imports, so it will use the shared instructions too. ${name} is created in ${project.folder} if it does not exist; its current content is kept.`,
    });
    if (!confirmed) return false;
    await linkInstructionFile(project.folder, name);
    return true;
  }

  registerHandlers(): void {
    ipcMain.handle(IpcChannel.GetProjectContext, (_event, projectId: unknown) =>
      this.context(projectId),
    );
    ipcMain.handle(
      IpcChannel.SaveProjectMemory,
      async (_event, projectId: unknown, text: unknown) => {
        const project = this.require(projectId);
        if (typeof text !== 'string') throw new Error('Invalid memory');
        await this.store.write(project.id, text);
        broadcast(IpcChannel.ProjectMemoryChanged, project.id);
      },
    );
    ipcMain.handle(IpcChannel.SaveProjectInstructions, (event, projectId: unknown, text: unknown) =>
      this.saveInstructions(BrowserWindow.fromWebContents(event.sender), projectId, text),
    );
    ipcMain.handle(IpcChannel.LinkProjectInstructions, (event, projectId: unknown, name: unknown) =>
      this.link(BrowserWindow.fromWebContents(event.sender), projectId, name),
    );
  }
}
