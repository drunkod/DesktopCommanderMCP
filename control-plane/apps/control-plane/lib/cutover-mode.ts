import { existsSync } from "node:fs";
import { join } from "node:path";

export class TaskAdmissionFrozenError extends Error {
  constructor() {
    super("Task admission is frozen for a controlled cutover");
    this.name = "TaskAdmissionFrozenError";
  }
}

export class EffectAdmissionFrozenError extends Error {
  constructor() {
    super("Device effect admission is frozen for a controlled cutover");
    this.name = "EffectAdmissionFrozenError";
  }
}

function statePath(envName: string, fileName: string): string | null {
  const explicit = process.env[envName]?.trim();
  if (explicit) return explicit;
  const root = process.env.REMOTE_MCP_ROOT?.trim();
  return root ? join(root, ".data", fileName) : null;
}

export function taskAdmissionFreezePath(): string | null {
  return statePath("REMOTE_MCP_TASK_ADMISSION_FREEZE_FILE", "task-admission.frozen");
}

export function effectAdmissionFreezePath(): string | null {
  return statePath("REMOTE_MCP_EFFECT_ADMISSION_FREEZE_FILE", "effect-admission.frozen");
}

export function publicIngressFreezePath(): string | null {
  return statePath("REMOTE_MCP_PUBLIC_INGRESS_FREEZE_FILE", "public-ingress.frozen");
}

export function isTaskAdmissionFrozen(): boolean {
  const path = taskAdmissionFreezePath();
  return path !== null && existsSync(path);
}

export function isEffectAdmissionFrozen(): boolean {
  const path = effectAdmissionFreezePath();
  return path !== null && existsSync(path);
}

export function isPublicIngressFrozen(): boolean {
  const path = publicIngressFreezePath();
  return path !== null && existsSync(path);
}
