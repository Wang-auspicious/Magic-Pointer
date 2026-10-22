import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createProjectStore} from '../electron/project_store';
import type {ProjectDetailsPatch, ProjectRunEnvironment} from '../electron/project_context';

test('named project environments survive reopening and remain independent', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-run-env-'));
  try {
    const store = createProjectStore({baseDir});
    const created = store.create({name: 'Research'});
    assert.ok(created.ok);
    const environments: ProjectRunEnvironment[] = [
      {
        id: 'review',
        name: 'Review',
        permissionPreset: 'read-only',
        modelSelection: {model: 'review-model', profileId: 'local'},
        effort: 'high',
        additionalFolders: ['D:/notes'],
      },
      {
        id: 'build',
        name: 'Build',
        permissionPreset: 'workspace-write',
        effort: 'max',
      },
    ];
    const result = store.update(created.project.id, {
      environments,
      defaultEnvironmentId: 'review',
    });
    assert.ok(result.ok);
    const reopened = createProjectStore({baseDir}).get(
      created.project.id,
    )!;
    assert.ok(reopened.environments);
    assert.deepEqual(reopened.environments, environments);
    assert.equal(reopened.defaultEnvironmentId, 'review');
    environments[0].modelSelection!.model = 'changed outside store';
    assert.equal(
      store.get(created.project.id)!.environments![0].modelSelection!.model,
      'review-model',
    );
    reopened.environments[0].additionalFolders!.push('D:/other');
    assert.deepEqual(
      store.get(created.project.id)!.environments![0].additionalFolders,
      ['D:/notes'],
    );
    const switched = store.update(created.project.id, {
      defaultEnvironmentId: 'build',
    });
    assert.ok(switched.ok);
    assert.equal(
      createProjectStore({baseDir}).get(created.project.id)!.defaultEnvironmentId,
      'build',
    );
    const cleared = store.update(created.project.id, {
      environments: [],
      defaultEnvironmentId: '',
    });
    assert.ok(cleared.ok);
    assert.deepEqual(store.get(created.project.id)!.environments, []);
    assert.equal(
      store.get(created.project.id)!.defaultEnvironmentId,
      '',
    );
  } finally {
    fs.rmSync(baseDir, {recursive: true, force: true});
  }
});

test('invalid defaults and failed saves preserve the last accepted environments', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-run-env-'));
  try {
    const store = createProjectStore({baseDir});
    const created = store.create({name: 'Research'});
    assert.ok(created.ok);
    assert.equal(
      store.update(created.project.id, {defaultEnvironmentId: 'missing'})
        .ok,
      false,
    );
    const environments: ProjectRunEnvironment[] = [
      {id: 'safe', name: 'Safe', permissionPreset: 'read-only'},
    ];
    assert.ok(
      store.update(created.project.id, {
        environments,
        defaultEnvironmentId: 'safe',
      }).ok,
    );
    assert.equal(
      store.update(created.project.id, {environments: []}).ok,
      false,
    );
    assert.equal(
      store.update(created.project.id, {
        environments: [{...environments[0], permissionPreset: 'unknown'}],
      } as unknown as ProjectDetailsPatch).ok,
      false,
    );
    const originalRename = fs.renameSync;
    try {
      fs.renameSync = () => {
        throw new Error('disk unavailable');
      };
      const failed = store.update(created.project.id, {
        environments: [{...environments[0], name: 'Edited'}],
      });
      assert.equal(failed.ok, false);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.deepEqual(
      store.get(created.project.id)!.environments,
      environments,
    );
    assert.deepEqual(
      createProjectStore({baseDir}).get(created.project.id)!.environments,
      environments,
    );
  } finally {
    fs.rmSync(baseDir, {recursive: true, force: true});
  }
});
