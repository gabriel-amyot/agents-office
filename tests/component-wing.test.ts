import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentForRepo, componentForWing } from '../src/addons/building/componentWing.js';

test('a frontend/portal repo maps to the portal wing', () => {
  assert.equal(componentForRepo('app-front-portal'), 'portal');
});

test('an agent/office/proxi repo maps to the agents wing', () => {
  assert.equal(componentForRepo('agents-office'), 'agents');
  assert.equal(componentForRepo('app-agent-hub'), 'agents');
  assert.equal(componentForRepo('proxi-hermes'), 'agents');
});

test('a DAC/terraform/infra repo maps to the infra wing', () => {
  assert.equal(componentForRepo('grp-dac-proximity-report'), 'infra');
  assert.equal(componentForRepo('klever-terraform-infra'), 'infra');
});

test('everything else, including an unmapped backend service, falls to the tooling default wing', () => {
  assert.equal(componentForRepo('app-proximity-report'), 'tooling');
  assert.equal(componentForRepo('claude-dev-settings'), 'tooling');
  assert.equal(componentForRepo(undefined), 'tooling');
});

test('infra is checked before the other wings, for a repo name that could match more than one', () => {
  // A DAC whose own name happens to carry "agent" too: deploy plumbing is the more specific signal.
  assert.equal(componentForRepo('grp-dac-agent-config'), 'infra');
});

// --- Issue #261 review round 3: a mission's own `component` field wins over the repo guess ---

test('componentForWing prefers a mission\'s own component field over the repo guess', () => {
  assert.equal(componentForWing({ repo: 'gabriel-amyot/klever-project-management', component: 'infra' }), 'infra');
  assert.equal(componentForWing({ repo: 'gabriel-amyot/agentic-engeneering-settings', component: 'portal' }), 'portal');
});

test('componentForWing falls back to the repo guess when component is absent, unknown, or not a real wing', () => {
  assert.equal(componentForWing({ repo: 'app-front-portal' }), 'portal');
  assert.equal(componentForWing({ repo: 'app-front-portal', component: undefined }), 'portal');
  assert.equal(componentForWing({ repo: 'app-front-portal', component: 'not-a-wing' }), 'portal');
  assert.equal(componentForWing({ repo: 'app-front-portal', component: '' }), 'portal');
});

test('componentForWing matches the real-world case this fixed: project-management repos, 8 of 9 missions no longer forced into tooling once each sets its own component', () => {
  assert.equal(componentForWing({ repo: 'gabriel-amyot/klever-project-management', component: 'agents' }), 'agents');
  assert.equal(componentForWing({ repo: 'gabriel-amyot/klever-project-management' }), 'tooling', 'no component set: still the honest repo-based default');
});
