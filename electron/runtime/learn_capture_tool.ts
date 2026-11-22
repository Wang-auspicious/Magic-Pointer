import {appendVaultTodo, saveVaultNote} from '../knowledge_vault';
import {
  ensureRoadshowCs336Course,
  getLearnCourse,
  listLearnCourses,
  recordAnnotationFeedback,
  type LearnCourse,
  type LearnCourseStoreOptions,
} from '../learn_course_store';
import type {ToolRegistry, ToolSpec} from './tools';

export interface LearnCaptureToolOptions {
  userDataDir: string;
  vaultDir?: string;
  storeOpts?: LearnCourseStoreOptions;
}

function resolveTargetCourse(
  userDataDir: string,
  requestedCourseId: string | undefined,
  storeOpts?: LearnCourseStoreOptions,
): LearnCourse {
  const cleanId = String(requestedCourseId || '').trim();
  if (cleanId) {
    const explicit = getLearnCourse(userDataDir, cleanId, storeOpts);
    if (explicit) {
      return explicit;
    }
  }
  const listing = listLearnCourses(userDataDir, storeOpts);
  if (listing.activeCourseId) {
    const active = getLearnCourse(
      userDataDir,
      listing.activeCourseId,
      storeOpts,
    );
    if (active) {
      return active;
    }
  }
  if (listing.courses.length > 0) {
    const first = getLearnCourse(userDataDir, listing.courses[0].id, storeOpts);
    if (first) {
      return first;
    }
  }
  return ensureRoadshowCs336Course(userDataDir, storeOpts);
}

/**
 * Registers `Learn.capture_to_course`, bridging Magic Pointer desktop/screen captures
 * and global explanations directly into the active Learn course living artifact and
 * the user's Obsidian vault / learning todos.
 */
export function registerLearnCaptureTool(
  registry: ToolRegistry,
  options: LearnCaptureToolOptions,
): void {
  const spec: ToolSpec = {
    name: 'Learn.capture_to_course',
    description:
      'Capture a highlighted sentence, formula, code snippet, screenshot explanation, or follow-up question from any app into the user’s active Learn course (living artifact annotations, confused/known signal, optional Obsidian vault note and learning todo).',
    input_schema: {
      type: 'object',
      properties: {
        courseId: {
          type: 'string',
          description:
            'Optional Learn course ID; defaults to the currently active course.',
        },
        quote: {
          type: 'string',
          description:
            'Key quote, formula, terminal output, or screen concept captured from the target app.',
        },
        note: {
          type: 'string',
          description:
            'Concise intuitive explanation, worked numeric example, or learner takeaway.',
        },
        section: {
          type: 'string',
          description:
            'Topic or course section label (e.g. "SwiGLU 对齐", "KV Cache").',
        },
        feedback: {
          type: 'string',
          enum: ['confused', 'verbose', 'known'],
          description:
            'Optional mastery/confusion signal to update the course learner profile.',
        },
        saveToVault: {
          type: 'boolean',
          description:
            'If true, also writes a markdown note to the course Obsidian vault folder.',
        },
        addTodo: {
          type: 'string',
          description:
            'Optional follow-up exercise or question to append to Obsidian LEARNING_TODOS.md.',
        },
        sourceUrl: {
          type: 'string',
          description: 'Optional URL or paper reference for provenance.',
        },
        sourceApp: {
          type: 'string',
          description: 'Optional desktop application name for provenance.',
        },
      },
      required: ['quote'],
      additionalProperties: false,
    },
    effect: 'reversible_write',
    deferred: false,
    is_concurrency_safe: false,
    used_backend: 'learn_course_store',
    execute: async rawArgs => {
      const args = (rawArgs || {}) as Record<string, unknown>;
      const quote = String(args.quote || '').trim();
      if (!quote) {
        return {
          ok: false,
          error: 'quote is required',
          usedBackend: 'learn_course_store',
        };
      }
      const note =
        typeof args.note === 'string' && args.note.trim()
          ? args.note.trim()
          : undefined;
      const section =
        typeof args.section === 'string' && args.section.trim()
          ? args.section.trim()
          : '桌面摘录';
      const rawFb = String(args.feedback || '').trim();
      const feedback =
        rawFb === 'confused' || rawFb === 'verbose' || rawFb === 'known'
          ? rawFb
          : undefined;
      const course = resolveTargetCourse(
        options.userDataDir,
        typeof args.courseId === 'string' ? args.courseId : undefined,
        options.storeOpts,
      );
      const updated = recordAnnotationFeedback(
        options.userDataDir,
        course.id,
        {
          type: feedback ? 'fb' : note ? 'note' : 'hl',
          ...(feedback ? {fb: feedback} : {}),
          quote,
          section,
          ...(note ? {note} : {}),
        },
        options.storeOpts,
      );
      const vaultRoot =
        String(options.vaultDir || '').trim() ||
        String(course.vaultDir || '').trim();
      let vaultResult:
        | {ok: boolean; filePath: string; relativePath: string}
        | undefined;
      if (args.saveToVault === true && vaultRoot) {
        const sourceText = [args.sourceApp, args.sourceUrl]
          .filter(v => typeof v === 'string' && v.trim())
          .join(' · ');
        const bodyParts = [`## ${section}`, '', `> ${quote}`];
        if (note) {
          bodyParts.push('', note);
        }
        if (feedback) {
          bodyParts.push('', `- 状态信号：\`${feedback}\``);
        }
        vaultResult = saveVaultNote(vaultRoot, {
          title: `${section} - ${quote.slice(0, 32)}`,
          folder: 'Learn',
          tags: ['magic-pointer', 'learn'],
          ...(sourceText ? {source: sourceText} : {}),
          body: bodyParts.join('\n'),
        });
      }
      let todoResult:
        | {ok: boolean; filePath: string; appended: boolean; error?: string}
        | undefined;
      const todoText =
        typeof args.addTodo === 'string' ? args.addTodo.trim() : '';
      if (todoText && vaultRoot) {
        todoResult = appendVaultTodo(vaultRoot, {
          text: todoText,
          title: section || course.title,
          ...(typeof args.sourceUrl === 'string' && args.sourceUrl.trim()
            ? {sourceUrl: args.sourceUrl.trim()}
            : {}),
        });
      }
      return {
        ok: true,
        courseId: course.id,
        courseTitle: course.title,
        section,
        annotationSaved: Boolean(updated),
        ...(vaultResult
          ? {
              vaultPath: vaultResult.relativePath,
              vaultFilePath: vaultResult.filePath,
            }
          : {}),
        ...(todoResult
          ? {
              todoAppended: todoResult.appended,
              todoPath: todoResult.filePath,
            }
          : {}),
        usedBackend: 'learn_course_store',
      };
    },
  };
  registry.register(spec);
}
