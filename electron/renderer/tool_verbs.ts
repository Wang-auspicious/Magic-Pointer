/* exported ToolVerbs */

interface MagicPointerToolVerbsApi {
  readonly RUNNING_LABELS_BY_NAME: Readonly<Record<string, string>>;
  readonly CLI_RUNNING_LABELS: Readonly<Record<string, string>>;
  readonly DONE_LABELS_BY_NAME: Readonly<Record<string, string>>;
  readonly CANCELLED_LABELS_BY_NAME: Readonly<Record<string, string>>;
  runningVerbFor(raw: string): string;
  doneVerbFor(raw: string): string;
  cancelledVerbFor(raw: string): string;
}

declare global {
  // Runtime value comes from the tool_verbs.js script tag, which must load
  // before execution_view.js; execution_view.ts degrades to raw tool names
  // when the tag is absent.
  const ToolVerbs: MagicPointerToolVerbsApi;
}

// English-default tool verb phrasebook. The wording is the reference's own
// (claude.ai tool-card code, reports 31/32/33): every label below is a lookup
// and never a suffix rule, so `Write` runs as "Creating a file" rather than
// "Writing a file". Keys are normalised tool names; see normaliseToolName.
// The running line in execution_view.ts reads runningVerbFor; the done and
// cancelled maps are exported under the same stable keys so the locale layer
// can key translations off them without touching chat_view.ts.
const ToolVerbs = (() => {
  /**
   * Claude's `BD`. The in-flight verb for every name it can spell, keyed by
   * normalised tool name.
   */
  const RUNNING_LABELS_BY_NAME: Readonly<Record<string, string>> = {
    read: 'Reading a file',
    view: 'Reading a file',
    write: 'Creating a file',
    create_file: 'Creating a file',
    edit: 'Editing a file',
    str_replace: 'Editing a file',
    str_replace_editor: 'Editing a file',
    multi_edit: 'Editing files',
    notebook_edit: 'Editing a notebook',
    open_file: 'Opening file',
    update_file: 'Updating file',
    close_file: 'Closing file',
    delete_file: 'Deleting a file',
    file_search: 'Searching files',
    grep: 'Searching files',
    glob: 'Looking for files',
    ls: 'Listing files',
    present_files: 'Sharing files',
    send_user_file: 'Sharing files',
    send_user_message: 'Sending message',
    push_notification: 'Sending notification',
    repl: 'Running code',
    java_script: 'Running code',
    recent_chats: 'Searching past chats',
    conversation_search: 'Searching past chats',
    project_knowledge_search: 'Searching project knowledge',
    drive_search: 'Searching Google Drive',
    web_fetch: 'Reading a page',
    web_search: 'Searching the web',
    web_search_fast: 'Searching the web',
    task: 'Running an agent',
    agent: 'Running an agent',
    skill: 'Running skill',
    tool_search: 'Loading tools',
    exit_plan_mode: 'Proposing a plan',
    enter_plan_mode: 'Starting a plan',
    todo_write: 'Updating the plan',
    ask_user_question: 'Asking a question',
    bash_output: 'Checking command output',
    list_mcp_resources: 'Listing resources',
    list_mcp_resources_tool: 'Listing resources',
    read_resource_link: 'Reading resource',
    read_mcp_resource_tool: 'Reading resource',
    read_widget_context: 'Reading widget context',
  };

  /**
   * The command-class table recorded alongside `BD`. It takes precedence for
   * the CLI tool names and is the only running table whose labels carry a
   * trailing ellipsis, which is the shape the thin running line uses.
   */
  const CLI_RUNNING_LABELS: Readonly<Record<string, string>> = {
    glob: 'Looking for files…',
    grep: 'Searching files…',
    read: 'Reading a file…',
    write: 'Creating a file…',
    edit: 'Editing a file…',
    bash: 'Running a command…',
    bash_tool: 'Running a command…',
    power_shell: 'Running a command…',
    powershell: 'Running a command…',
    web_fetch: 'Reading a page…',
    web_search: 'Searching the web…',
    task: 'Multitasking…',
    agent: 'Multitasking…',
    send_message: 'Multitasking…',
    task_get: 'Reading task…',
    task_list: 'Listing tasks…',
    task_create: 'Updating tasks…',
    task_update: 'Updating tasks…',
    task_stop: 'Updating tasks…',
    todo_write: 'Updating the plan…',
    tool_search: 'Loading tools…',
    ask_user_question: 'Asking a question…',
    skill: 'Using a skill…',
    send_user_message: 'Sending message…',
    send_user_file: 'Sharing files…',
    push_notification: 'Sending notification…',
    fetch_inbox_message: 'Reading the thread…',
    bash_output: 'Checking command output…',
    kill_bash: 'Stopping a command…',
    ls: 'Listing files…',
    multi_edit: 'Editing files…',
    notebook_edit: 'Editing notebook…',
    enter_plan_mode: 'Starting a plan…',
    exit_plan_mode: 'Proposing a plan…',
    workflow: 'Running workflow…',
    repl: 'Running code…',
    java_script: 'Running code…',
    appifact_repl: 'Running code…',
    poll: 'Waiting for results…',
    tmux: 'Running terminal…',
  };

  /**
   * Claude's `YI`. Only the verbs whose past tense is not "+ed" are listed.
   */
  const DONE_LABELS_BY_NAME: Readonly<Record<string, string>> = {
    ask_user_question: 'Asked a question',
    bash_output: 'Checked command output',
    enter_plan_mode: 'Started a plan',
    exit_plan_mode: 'Proposed a plan',
    java_script: 'Ran code',
    repl: 'Ran code',
    ls: 'Listed files',
    push_notification: 'Sent notification',
    present_files: 'Shared files',
    send_user_file: 'Shared files',
    send_user_message: 'Sent message',
    skill: 'Ran skill',
    tool_search: 'Loaded tools',
  };

  /** Claude's `XI`. Keyed by normalised name, exactly as the reference keys it. */
  const CANCELLED_LABELS_BY_NAME: Readonly<Record<string, string>> = {
    read: 'Stopped reading file',
    write: 'Stopped creating file',
    recent_chats: 'Stopped searching past chats',
    conversation_search: 'Stopped searching past chats',
    project_knowledge_search: 'Stopped searching project knowledge',
    tool_search: 'Stopped loading tools',
    bash: 'Stopped running the command',
    bash_tool: 'Stopped running the command',
    power_shell: 'Stopped running the command',
    web_search: 'Stopped searching the web',
    web_search_fast: 'Stopped searching the web',
  };

  /**
   * Claude's `wR`. camelCase splits to snake_case, then everything lowercases:
   * `Bash` to `bash`, `BashTool` to `bash_tool`, `PowerShell` to `power_shell`.
   */
  function normaliseToolName(raw: string): string {
    return raw.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  }

  /**
   * MP's own spellings, same as chat_view.ts: `AskUser` and `Search` resolve
   * to the reference's question and web tables.
   */
  const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
    AskUser: 'ask_user_question',
    Search: 'web_search',
  };

  function keyFor(raw: string): string {
    return normaliseToolName(TOOL_NAME_ALIASES[raw] ?? raw);
  }

  /**
   * In-flight phrase for the running line. A tool nobody has named keeps its
   * raw name mid-flight, because showing the wrong tool is worse than showing
   * the wrong tense.
   */
  function runningVerbFor(raw: string): string {
    const key = keyFor(raw);
    return CLI_RUNNING_LABELS[key] ?? RUNNING_LABELS_BY_NAME[key] ?? raw;
  }

  function doneVerbFor(raw: string): string {
    return DONE_LABELS_BY_NAME[keyFor(raw)] ?? raw;
  }

  function cancelledVerbFor(raw: string): string {
    return CANCELLED_LABELS_BY_NAME[keyFor(raw)] ?? raw;
  }

  return {
    RUNNING_LABELS_BY_NAME,
    CLI_RUNNING_LABELS,
    DONE_LABELS_BY_NAME,
    CANCELLED_LABELS_BY_NAME,
    runningVerbFor,
    doneVerbFor,
    cancelledVerbFor,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ToolVerbs;
}
