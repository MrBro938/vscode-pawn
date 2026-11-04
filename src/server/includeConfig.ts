import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

type JsonObject = { [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item.trim())
    : [];

const isDirectory = (value: string): boolean => {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (value: string): boolean => {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
};

const uniquePaths = (values: Iterable<string>): string[] => {
  const result = new Map<string, string>();
  for (const value of values) {
    const normalized = path.resolve(value);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (!result.has(key)) result.set(key, normalized);
  }
  return Array.from(result.values());
};

const appendExistingDirectory = (values: string[], candidate: string) => {
  const absolute = path.resolve(candidate);
  if (isDirectory(absolute)) values.push(absolute);
};

const resolvePath = (value: string, baseDirectory: string): string =>
  path.resolve(baseDirectory, value.replace(/^["']|["']$/g, ""));

const parseCompilerArgs = (
  args: string[],
  baseDirectory: string
): string[] => {
  const result: string[] = [];

  args.forEach((rawArg) => {
    const arg = rawArg.trim();
    if (!arg) return;

    // Pawn accepts -i<dir>, -i=<dir> and -i:<dir>. On Windows it also
    // accepts slash-prefixed compiler options.
    const match = /^[-/][iI](?:[=:])?(.+)$/.exec(arg);
    if (!match) return;

    const includePath = match[1].replace(/^["']|["']$/g, "");
    if (includePath) result.push(resolvePath(includePath, baseDirectory));
  });

  return result;
};

/**
 * pawn.cfg is a Pawn compiler response file: whitespace-separated compiler
 * options parsed before explicit command-line arguments. Preserve the order
 * of its -i options because the compiler searches include directories in order.
 */
export const parsePawnCfgIncludePaths = (
  contents: string,
  configDirectory: string
): string[] => {
  const tokens = contents.match(/(?:-[^\s]+|\/[iI][^\s]+)/g) || [];
  return parseCompilerArgs(tokens, configDirectory);
};

interface PackageBuild {
  includes?: unknown;
  args?: unknown;
  compiler?: unknown;
}

const firstBuildConfiguration = (packageDefinition: JsonObject): PackageBuild[] => {
  const single = packageDefinition.build;
  if (isObject(single)) return [single as PackageBuild];

  const multiple = packageDefinition.builds;
  if (Array.isArray(multiple)) {
    const first = multiple.find(isObject);
    return first ? [first as PackageBuild] : [];
  }

  if (isObject(multiple)) {
    const first = Object.values(multiple).find(isObject);
    return first ? [first as PackageBuild] : [];
  }

  return [];
};

const readPackageDefinition = (directory: string): JsonObject | undefined => {
  // sampctl supports either manifest format. Keep pawn.json first so existing
  // projects retain their current behavior if both files are present.
  const jsonFilename = path.join(directory, "pawn.json");
  if (isFile(jsonFilename)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(jsonFilename, "utf8"));
      if (isObject(parsed)) return parsed;
    } catch {
      // Fall back to pawn.yaml when the JSON manifest is invalid.
    }
  }

  const yamlFilename = path.join(directory, "pawn.yaml");
  if (!isFile(yamlFilename)) return undefined;

  try {
    const parsed: unknown = parseYaml(fs.readFileSync(yamlFilename, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const addCompilerDirectory = (
  candidate: string,
  compilerDirectories: string[],
  compilerIncludeDirectories: string[]
) => {
  const absolute = path.resolve(candidate);
  const compilerDirectory = isDirectory(absolute)
    ? absolute
    : path.dirname(absolute);

  if (!isDirectory(compilerDirectory)) return;
  compilerDirectories.push(compilerDirectory);

  // These are compiler-provided fallback includes, not explicit -i paths.
  const adjacentInclude = path.join(compilerDirectory, "include");
  if (isDirectory(adjacentInclude)) compilerIncludeDirectories.push(adjacentInclude);

  const parentInclude = path.join(path.dirname(compilerDirectory), "include");
  if (isDirectory(parentInclude)) compilerIncludeDirectories.push(parentInclude);
};

const readPawnCfg = (
  compilerDirectory: string,
  compilerConfigIncludeDirectories: string[]
) => {
  const configFile = path.join(compilerDirectory, "pawn.cfg");
  if (!isFile(configFile)) return;

  try {
    const contents = fs.readFileSync(configFile, "utf8");
    parsePawnCfgIncludePaths(contents, compilerDirectory).forEach((directory) => {
      appendExistingDirectory(compilerConfigIncludeDirectories, directory);
    });
  } catch {
    // Ignore inaccessible compiler response files.
  }
};

const addPackageBuildIncludes = (
  packageDefinition: JsonObject,
  packageDirectory: string,
  buildIncludeDirectories: string[],
  compilerDirectories: string[],
  compilerIncludeDirectories: string[]
) => {
  firstBuildConfiguration(packageDefinition).forEach((build) => {
    asStringArray(build.includes).forEach((includePath) => {
      appendExistingDirectory(
        buildIncludeDirectories,
        resolvePath(includePath, packageDirectory)
      );
    });

    parseCompilerArgs(asStringArray(build.args), packageDirectory).forEach((directory) => {
      appendExistingDirectory(buildIncludeDirectories, directory);
    });

    if (isObject(build.compiler)) {
      const compilerPath = asString(build.compiler.path);
      if (compilerPath) {
        addCompilerDirectory(
          resolvePath(compilerPath, packageDirectory),
          compilerDirectories,
          compilerIncludeDirectories
        );
      }
    }
  });
};

const dependencyDirectoryNames = (packageDefinition?: JsonObject): string[] =>
  asStringArray(packageDefinition?.dependencies).map((dependency) => {
    const withoutQuery = dependency.split(/[?#]/, 1)[0];
    const segments = withoutQuery.split(/[\\/]/);
    const last = segments[segments.length - 1] || "";
    return last.replace(/\.git$/i, "").split("@", 1)[0];
  }).filter(Boolean);

const walkDependencyDirectories = (
  directory: string,
  dependencyIncludeDirectories: string[],
  compilerDirectories: string[],
  compilerIncludeDirectories: string[],
  visited: Set<string>,
  depth: number,
  preferredOrder: string[] = []
) => {
  if (depth > 4 || !isDirectory(directory)) return;

  const key = process.platform === "win32"
    ? path.resolve(directory).toLowerCase()
    : path.resolve(directory);
  if (visited.has(key)) return;
  visited.add(key);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const folders = entries
    .filter((entry) =>
      entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules"
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  // sampctl's -i order follows the dependencies array. Any folders not listed
  // there are still discovered, but appended deterministically.
  const orderedFolders: fs.Dirent[] = [];
  const remaining = new Map(folders.map((entry) => [entry.name, entry]));
  preferredOrder.forEach((name) => {
    const entry = remaining.get(name);
    if (!entry) return;
    orderedFolders.push(entry);
    remaining.delete(name);
  });
  orderedFolders.push(...remaining.values());

  orderedFolders.forEach((entry) => {
    const packageDirectory = path.join(directory, entry.name);
    const packageDefinition = readPackageDefinition(packageDirectory);

    if (packageDefinition) {
      const includePath = asString(packageDefinition.include_path);
      const includeDirectory = includePath
        ? resolvePath(includePath, packageDirectory)
        : packageDirectory;

      appendExistingDirectory(dependencyIncludeDirectories, includeDirectory);
      addPackageBuildIncludes(
        packageDefinition,
        packageDirectory,
        dependencyIncludeDirectories,
        compilerDirectories,
        compilerIncludeDirectories
      );
    } else {
      appendExistingDirectory(dependencyIncludeDirectories, packageDirectory);
    }

    walkDependencyDirectories(
      path.join(packageDirectory, "dependencies"),
      dependencyIncludeDirectories,
      compilerDirectories,
      compilerIncludeDirectories,
      visited,
      depth + 1,
      dependencyDirectoryNames(packageDefinition)
    );
  });
};

export interface ResolveIncludeConfigurationOptions {
  workspaceRoots: string[];
  customIncludePaths?: string[];
  compilerPath?: string;
}

export interface ResolveIncludeConfigurationResult {
  /** Ordered search path list. Earlier entries have higher precedence. */
  includeDirectories: string[];
  compilerDirectories: string[];
}

export const resolveIncludeConfiguration = (
  options: ResolveIncludeConfigurationOptions
): ResolveIncludeConfigurationResult => {
  const compilerConfigIncludeDirectories: string[] = [];
  const projectIncludeDirectories: string[] = [];
  const buildIncludeDirectories: string[] = [];
  const dependencyIncludeDirectories: string[] = [];
  const compilerIncludeDirectories: string[] = [];
  const customIncludeDirectories: string[] = [];
  const compilerDirectories: string[] = [];

  options.workspaceRoots.forEach((workspaceRoot) => {
    const root = path.resolve(workspaceRoot);
    if (!isDirectory(root)) return;

    // sampctl adds the package root as an include directory. Keep it before
    // dependencies so project-local files win on same-name collisions.
    appendExistingDirectory(projectIncludeDirectories, root);

    const packageDefinition = readPackageDefinition(root);
    if (packageDefinition) {
      const packageIncludePath = asString(packageDefinition.include_path);
      if (packageIncludePath) {
        appendExistingDirectory(
          projectIncludeDirectories,
          resolvePath(packageIncludePath, root)
        );
      }

      addPackageBuildIncludes(
        packageDefinition,
        root,
        buildIncludeDirectories,
        compilerDirectories,
        compilerIncludeDirectories
      );
    }

    // Compiler response-file options are parsed before command-line -i flags.
    // Read known compiler locations now, then append their paths in that order.
    ["pawno", "qawno", "compiler", "bin"].forEach((relative) => {
      const directory = path.join(root, relative);
      if (isDirectory(directory)) {
        addCompilerDirectory(
          directory,
          compilerDirectories,
          compilerIncludeDirectories
        );
      }
    });

    if (isFile(path.join(root, "pawn.cfg"))) {
      compilerDirectories.push(root);
    }

    // sampctl stores ensured dependencies below <package>/dependencies.
    walkDependencyDirectories(
      path.join(root, "dependencies"),
      dependencyIncludeDirectories,
      compilerDirectories,
      compilerIncludeDirectories,
      new Set<string>(),
      0,
      dependencyDirectoryNames(packageDefinition)
    );

    // Local plugins/components without dependency declarations are discovered
    // deterministically after regular sampctl dependencies.
    ["plugins", "components"].forEach((folder) => {
      walkDependencyDirectories(
        path.join(root, folder),
        dependencyIncludeDirectories,
        compilerDirectories,
        compilerIncludeDirectories,
        new Set<string>(),
        0
      );
    });

    // Legacy include folders are fallback paths, after explicit build/dependency
    // paths. Compiler-provided standard includes are the final fallback.
    ["include", "includes", "pawno/include", "qawno/include"].forEach((relative) => {
      appendExistingDirectory(
        compilerIncludeDirectories,
        path.join(root, relative)
      );
    });

    const entry = asString(packageDefinition?.entry);
    if (entry) {
      appendExistingDirectory(
        projectIncludeDirectories,
        path.dirname(resolvePath(entry, root))
      );
    }
  });

  if (options.compilerPath) {
    options.workspaceRoots.forEach((root) => {
      addCompilerDirectory(
        resolvePath(options.compilerPath!, root),
        compilerDirectories,
        compilerIncludeDirectories
      );
    });
  }

  // pawn.cfg is read before explicit build args, just as the compiler response
  // file is consumed before the command-line options supplied by sampctl.
  compilerDirectories.forEach((directory) => {
    readPawnCfg(directory, compilerConfigIncludeDirectories);
  });

  options.customIncludePaths?.forEach((includePath) => {
    options.workspaceRoots.forEach((root) => {
      appendExistingDirectory(
        customIncludeDirectories,
        resolvePath(includePath, root)
      );
    });
  });

  return {
    includeDirectories: uniquePaths([
      ...compilerConfigIncludeDirectories,
      ...projectIncludeDirectories,
      ...buildIncludeDirectories,
      ...dependencyIncludeDirectories,
      ...compilerIncludeDirectories,
      ...customIncludeDirectories
    ]),
    compilerDirectories: uniquePaths(compilerDirectories),
  };
};
