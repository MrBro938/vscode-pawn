const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  parsePawnCfgIncludePaths,
  resolveIncludeConfiguration
} = require("../out/server/includeConfig.js");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pawn-include-config-"));

const mkdir = (relative) => {
  const absolute = path.join(temporaryRoot, relative);
  fs.mkdirSync(absolute, { recursive: true });
  return absolute;
};

const write = (relative, content) => {
  const absolute = path.join(temporaryRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
  return absolute;
};

const asSet = (values) => new Set(values.map((value) => path.resolve(value)));

try {
  mkdir("include");
  mkdir("src/includes");
  mkdir("build/includes");
  mkdir("builds/release/includes");
  mkdir("args/includes");
  mkdir("custom/includes");
  mkdir("pawno/include");
  mkdir("pawno/cfg/includes");
  mkdir("pawno/cfg/second");
  mkdir("dependencies/YSI-Includes/include");
  mkdir("dependencies/samp-stdlib");

  write("pawn.json", JSON.stringify({
    entry: "gamemodes/main.pwn",
    include_path: "src/includes",
    dependencies: ["pawn-lang/samp-stdlib", "pawn-lang/YSI-Includes"],
    build: {
      includes: ["build/includes"],
      args: ["-iargs/includes", "-O2"],
      compiler: { path: "pawno" }
    },
    builds: [
      { name: "release", includes: ["builds/release/includes"] }
    ]
  }, null, 2));

  write("dependencies/YSI-Includes/pawn.json", JSON.stringify({
    include_path: "include"
  }));
  write("dependencies/samp-stdlib/pawn.json", JSON.stringify({}));
  write("pawno/pawn.cfg", [
    "-d3",
    "-icfg/includes",
    "-i=cfg/second",
    "-O2"
  ].join("\n"));

  const parsedCfg = parsePawnCfgIncludePaths(
    '-d3 -icfg/includes -i=cfg/second -O2',
    path.join(temporaryRoot, "pawno")
  );
  assert.deepEqual(parsedCfg, [
    path.join(temporaryRoot, "pawno", "cfg/includes"),
    path.join(temporaryRoot, "pawno", "cfg/second")
  ], "pawn.cfg parser should extract attached -i options and ignore other compiler flags");

  const result = resolveIncludeConfiguration({
    workspaceRoots: [temporaryRoot],
    customIncludePaths: ["custom/includes"],
    compilerPath: "pawno/pawncc.exe"
  });

  const directories = asSet(result.includeDirectories);
  const expected = [
    "include",
    "src/includes",
    "build/includes",
    "args/includes",
    "custom/includes",
    "pawno/include",
    "pawno/cfg/includes",
    "pawno/cfg/second",
    "dependencies/YSI-Includes/include",
    "dependencies/samp-stdlib"
  ].map((relative) => path.join(temporaryRoot, relative));

  expected.forEach((directory) => {
    assert.ok(
      directories.has(path.resolve(directory)),
      "include configuration should contain " + directory
    );
  });

  const ordered = result.includeDirectories.map((directory) => path.resolve(directory));
  const positionOf = (relative) => ordered.indexOf(path.resolve(temporaryRoot, relative));

  assert.ok(
    positionOf("pawno/cfg/includes") < positionOf("build/includes"),
    "pawn.cfg -i paths should be searched before explicit sampctl build includes"
  );
  assert.ok(
    positionOf("build/includes") < positionOf("args/includes"),
    "build.includes should retain its order before -i options in build.args"
  );
  assert.ok(
    positionOf("args/includes") < positionOf("dependencies/samp-stdlib"),
    "explicit build includes should take precedence over dependencies"
  );
  assert.ok(
    positionOf("dependencies/samp-stdlib") < positionOf("dependencies/YSI-Includes/include"),
    "dependency include paths should follow the dependencies array order"
  );
  assert.ok(
    positionOf("dependencies/YSI-Includes/include") < positionOf("pawno/include"),
    "compiler-standard includes should be searched after explicit dependency paths"
  );
  assert.ok(
    positionOf("custom/includes") > positionOf("pawno/include"),
    "extension custom include paths should be appended as additional fallbacks"
  );
  assert.ok(
    !directories.has(path.join(temporaryRoot, "builds/release/includes")),
    "only the default build configuration should determine the active include order"
  );

  assert.ok(
    result.compilerDirectories.some((directory) =>
      path.resolve(directory) === path.join(temporaryRoot, "pawno")
    ),
    "compiler directory should be recognized from pawn.json and compilerPath"
  );

  console.log("Pawn include configuration tests passed.");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
