'use strict';

(() => {
type UnknownRecord = Record<string, unknown>;

interface TransportOptions {
  onState?: (state: UnknownRecord) => void;
  send: (taskInput: UnknownRecord) => Promise<UnknownRecord>;
}

interface SubmitOptions {
  onAccepted?: () => void;
}

function taskSources() {
  const available = (globalThis as typeof globalThis & { TaskSources?: any }).TaskSources;
  if (available) return available;
  if (typeof module !== 'undefined' && module.exports) return require('./task_sources');
  throw new Error('TaskSources is unavailable');
}

function createTaskInputTransport({ send, onState = () => {} }: TransportOptions) {
  if (typeof send !== 'function') throw new TypeError('TaskInput transport requires send');
  return {
    async submit(value: unknown, { onAccepted = () => {} }: SubmitOptions = {}) {
      const taskInput = taskSources().normalizeTaskInput(value);
      onState({ inputId: taskInput.inputId, status: 'queueing' });
      let reply: UnknownRecord;
      try {
        reply = await send(taskInput);
      } catch (error) {
        const message = String((error as Error)?.message || error || 'bridge_failed');
        onState({ inputId: taskInput.inputId, status: 'failed', error: message });
        return { ok: false, error: message, inputId: taskInput.inputId };
      }
      const acknowledged = (
        reply?.ok === true
        && reply?.status === 'queued'
        && reply?.inputId === taskInput.inputId
      );
      if (!acknowledged) {
        const error = String(reply?.error || 'ack_mismatch');
        onState({ inputId: taskInput.inputId, status: 'failed', error });
        return { ok: false, error, inputId: taskInput.inputId };
      }
      const referenceRevision = Number.isInteger(reply.referenceRevision)
        ? Number(reply.referenceRevision)
        : undefined;
      onState({
        inputId: taskInput.inputId,
        status: 'accepted',
        ...(referenceRevision === undefined ? {} : { referenceRevision }),
      });
      onAccepted();
      return { ok: true, inputId: taskInput.inputId, status: 'queued', referenceRevision };
    },
  };
}

const TaskInputTransport = { createTaskInputTransport };
if (typeof module !== 'undefined' && module.exports) module.exports = TaskInputTransport;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { TaskInputTransport?: typeof TaskInputTransport })
    .TaskInputTransport = TaskInputTransport;
}
})();
