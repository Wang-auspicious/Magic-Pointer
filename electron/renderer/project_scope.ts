declare global {
  interface ProjectMembership {
    projectId?: string;
    workspaceRoot?: string;
  }

  interface ProjectScopeApi {
    key(project: MagicPointerProject): string;
    contains(project: MagicPointerProject, member: ProjectMembership): boolean;
    find(
      projects: readonly MagicPointerProject[],
      key: string,
    ): MagicPointerProject | undefined;
    forConversation(
      projects: readonly MagicPointerProject[],
      member: ProjectMembership,
    ): MagicPointerProject | undefined;
  }

  var ProjectScope: ProjectScopeApi;
}

(() => {
  function rootKey(root: string): string {
    return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function key(project: MagicPointerProject): string {
    return project.id || project.root;
  }

  function contains(
    project: MagicPointerProject,
    member: ProjectMembership,
  ): boolean {
    if (member.projectId !== undefined) {
      return Boolean(member.projectId) && member.projectId === project.id;
    }
    return Boolean(
      project.root &&
      member.workspaceRoot &&
      rootKey(project.root) === rootKey(member.workspaceRoot),
    );
  }

  function find(
    projects: readonly MagicPointerProject[],
    value: string,
  ): MagicPointerProject | undefined {
    return (
      projects.find(project => key(project) === value) ||
      projects.find(
        project =>
          value && project.root && rootKey(project.root) === rootKey(value),
      )
    );
  }

  const api: ProjectScopeApi = {
    key,
    contains,
    find,
    forConversation: (projects, member) =>
      projects.find(project => contains(project, member)),
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalThis.ProjectScope = api;
})();
