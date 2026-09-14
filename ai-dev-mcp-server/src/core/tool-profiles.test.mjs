import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_PROFILES,
  ALWAYS_ON_PROFILE,
  PROFILE_IDS,
  TOOL_PROFILES,
  auditProfileCoverage,
  filterToolsByProfiles,
  findProfile,
  parseProfileSetting,
  profileOfTool,
  profilesFromEnvironment,
  resolveToolNames
} from "./tool-profiles.mjs";

test("every profile is described well enough to choose it from a list", () => {
  for (const profile of TOOL_PROFILES) {
    assert.match(profile.id, /^[a-z]+$/, `${profile.id} is not a usable setting value`);
    assert.ok(profile.title.length > 0, `${profile.id} has no title`);
    assert.ok(profile.summary.endsWith("."), `${profile.id}: summary should be a sentence`);
    assert.ok(profile.tools.length > 0, `${profile.id} carries no tools`);
  }
  assert.deepEqual(PROFILE_IDS, TOOL_PROFILES.map((profile) => profile.id));
});

test("core is the only profile that cannot be switched off", () => {
  const always = TOOL_PROFILES.filter((profile) => profile.always).map((profile) => profile.id);
  assert.deepEqual(always, [ALWAYS_ON_PROFILE]);
});

test("core carries the spine of the promise and nothing optional", () => {
  const core = findProfile("core");
  for (const tool of ["compile_project_context", "recommend_skills", "begin_task", "verify_task", "complete_task"]) {
    assert.ok(core.tools.includes(tool), `core should carry ${tool}`);
  }
  for (const tool of ["run_frontend_qa", "archify_render", "import_skill_repo"]) {
    assert.ok(!core.tools.includes(tool), `core should not carry ${tool}`);
  }
});

test("no tool is filed under two profiles", () => {
  const seen = new Set();
  for (const profile of TOOL_PROFILES) {
    for (const tool of profile.tools) {
      assert.ok(!seen.has(tool), `${tool} is filed under more than one profile`);
      seen.add(tool);
    }
  }
});

test("findProfile is forgiving about case and padding, and reports a miss", () => {
  assert.equal(findProfile("  Frontend ").id, "frontend");
  assert.equal(findProfile("nope"), undefined);
  assert.equal(findProfile(""), undefined);
  assert.equal(findProfile(null), undefined);
});

test("profileOfTool answers for a known tool and stays quiet for an unknown one", () => {
  assert.equal(profileOfTool("rollback_task"), "git");
  assert.equal(profileOfTool("record_decision"), "memory");
  assert.equal(profileOfTool("not_a_tool"), undefined);
});

test("an absent setting means the whole surface", () => {
  for (const raw of [undefined, null, "", "   "]) {
    const parsed = parseProfileSetting(raw);
    assert.equal(parsed.all, true);
    assert.deepEqual(parsed.ids, [...PROFILE_IDS]);
    assert.deepEqual(parsed.unknown, []);
  }
});

test("`all` means the whole surface however it is written", () => {
  assert.equal(parseProfileSetting(ALL_PROFILES).all, true);
  assert.equal(parseProfileSetting("core, ALL").all, true);
});

test("a setting always includes core and is returned in documentation order", () => {
  const parsed = parseProfileSetting("qa,git");
  assert.deepEqual(parsed.ids, ["core", "git", "qa"]);
  assert.equal(parsed.all, false);
});

test("profiles may be separated by commas, spaces or both", () => {
  assert.deepEqual(parseProfileSetting("git qa").ids, ["core", "git", "qa"]);
  assert.deepEqual(parseProfileSetting("git,  qa ,").ids, ["core", "git", "qa"]);
});

test("a typo costs a session nothing but the profile it misspelled", () => {
  const parsed = parseProfileSetting("git,frontened,memory");
  assert.deepEqual(parsed.ids, ["core", "memory", "git"]);
  assert.deepEqual(parsed.unknown, ["frontened"]);
});

test("naming every profile by hand is the same as asking for all", () => {
  const parsed = parseProfileSetting(PROFILE_IDS.join(","));
  assert.equal(parsed.all, true);
});

test("profilesFromEnvironment reads AI_DEV_PROFILES and says where the answer came from", () => {
  const set = profilesFromEnvironment({ AI_DEV_PROFILES: "memory" });
  assert.deepEqual(set.ids, ["core", "memory"]);
  assert.equal(set.source, "AI_DEV_PROFILES");

  const unset = profilesFromEnvironment({});
  assert.equal(unset.all, true);
  assert.match(unset.source, /default/);
});

test("profilesFromEnvironment falls back to the real environment", () => {
  const previous = process.env.AI_DEV_PROFILES;
  delete process.env.AI_DEV_PROFILES;
  try {
    assert.equal(profilesFromEnvironment().all, true);
  } finally {
    if (previous !== undefined) process.env.AI_DEV_PROFILES = previous;
  }
});

test("resolveToolNames adds core to whatever it is given, and ignores a name it does not know", () => {
  const names = resolveToolNames(["git", "made_up"]);
  assert.ok(names.has("begin_task"), "core should always resolve");
  assert.ok(names.has("rollback_task"), "git should resolve");
  assert.ok(!names.has("run_frontend_qa"), "frontend was not asked for");
  assert.equal(names.size, findProfile("core").tools.length + findProfile("git").tools.length);
});

test("filterToolsByProfiles keeps the server's order and drops the rest", () => {
  const tools = [
    { name: "begin_task" },
    { name: "run_frontend_qa" },
    { name: "rollback_task" },
    { name: "complete_task" }
  ];
  assert.deepEqual(
    filterToolsByProfiles(tools, ["git"]).map((tool) => tool.name),
    ["begin_task", "rollback_task", "complete_task"]
  );
});

test("filterToolsByProfiles keeps a tool no profile has heard of", () => {
  const tools = [{ name: "begin_task" }, { name: "some_extension_tool" }];
  assert.deepEqual(
    filterToolsByProfiles(tools, []).map((tool) => tool.name),
    ["begin_task", "some_extension_tool"]
  );
});

test("asking for every profile filters nothing away", () => {
  const tools = TOOL_PROFILES.flatMap((profile) => profile.tools.map((name) => ({ name })));
  assert.equal(filterToolsByProfiles(tools, [...PROFILE_IDS]).length, tools.length);
});

test("auditProfileCoverage names a tool with no profile and a profile with no tool", () => {
  const mapped = TOOL_PROFILES.flatMap((profile) => [...profile.tools]);
  assert.deepEqual(auditProfileCoverage(mapped), { missing: [], unknown: [], duplicated: [] });

  const added = auditProfileCoverage([...mapped, "brand_new_tool"]);
  assert.deepEqual(added.missing, ["brand_new_tool"]);
  assert.deepEqual(added.unknown, []);

  const removed = auditProfileCoverage(mapped.filter((name) => name !== "usage_report"));
  assert.deepEqual(removed.missing, []);
  assert.deepEqual(removed.unknown, ["usage_report"]);
});
