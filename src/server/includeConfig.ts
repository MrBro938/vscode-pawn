import * as fs from "fs";
import * as path from "path";

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
 * options parsed before the explicit command line arguments. Its -i options
 * are relative to the compiler's working directory in common Pawno/Qawno
 * setups, so the compiler directory is used as the base.
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

const buildConfigurations = (packageDefinition: JsonObject): PackageBuild[] => {
  const result: PackageBuild[] = [];
  const single = packageDefinition.build;
  if (isObject(single)) result.push(single as PackageBuild);

  const multiple = packageDefinition.builds;
  if (Array.isArray(multiple)) {
    multiple.forEach((item) => {
      if (isObject(item)) result.push(item as PackageBuild);
    });
  } else if (isObject(multiple)) {
    Object.values(multiple).forEach((item) => {
      if (isObject(item)) result.push(item as PackageBuild);
    });
  }

  return result;
};

const readPackageDefinition = (directory: string): JsonObject | undefined => {
  const filename = path.join(directory, "pawn.json");
  if (!isFile(filename)) return undefined;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const addCompilerDirectory = (
  candidate: string,
  compilerDirectories: Set<string>,
  includeDirectories: Set<string>
) => {
  const absolute = path.resolve(candidate);
  const compilerDirectory = isDirectory(absolute)
    ? absolute
    : path.dirname(absolute);

  if (!isDirectory(compilerDirectory)) return;
  compilerDirectories.add(compilerDirectory);

  // The standard Pawn compiler searches for "include" beside the compiler,
  // then one level above when the executable lives in a bin-like subfolder.
  const adjacentInclude = path.join(compilerDirectory, "include");
  if (isDirectory(adjacentInclude)) includeDirectories.add(adjacentInclude);

  const parentInclude = path.join(path.dirname(compilerDirectory), "include");
  if (isDirectory(parentInclude)) includeDirectories.add(parentInclude);
};

const readPawnCfg = (
  compilerDirectory: string,
  includeDirectories: Set<string>
) => {
  const configFile = path.join(compilerDirectory, "pawn.cfg");
  if (!isFile(configFile)) return;

  try {
    const contents = fs.readFileSync(configFile, "utf8");
    parsePawnCfgIncludePaths(contents, compilerDirectory).forEach((directory) => {
      if (isDirectory(directory)) includeDirectories.add(directory);
    });
  } catch {
    // Ignore inaccessible compiler response files.
  }
};

const addPackageBuildIncludes = (
  packageDefinition: JsonObject,
  packageDirectory: string,
  includeDirectories: Set<string>,
  compilerDirectories: Set<string>
) => {
  const packageIncludePath = asString(packageDefinition.include_path);
  if (packageIncludePath) {
    const resolved = resolvePath(packageIncludePath, packageDirectory);
    if (isDirectory(resolved)) includeDirectories.add(resolved);
  }

  buildConfigurations(packageDefinition).forEach((build) => {
    asStringArray(build.includes).forEach((includePath) => {
      const resolved = resolvePath(includePath, packageDirectory);
      if (isDirectory(resolved)) includeDirectories.add(resolved);
    });

    const args = asStringArray(build.args);
    parseCompilerArgs(args, packageDirectory).forEach((directory) => {
      if (isDirectory(directory)) includeDirectories.add(directory);
    });

    if (isObject(build.compiler)) {
      const compilerPath = asString(build.compiler.path);
      if (compilerPath) {
        addCompilerDirectory(
          resolvePath(compilerPath, packageDirectory),
          compilerDirectories,
          includeDirectories
        );
      }
    }
  });
};

const walkDependencyDirectories = (
  directory: string,
  includeDirectories: Set<string>,
  compilerDirectories: Set<string>,
  visited: Set<string>,
  depth: number
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

  entries.forEach((entry) => {
    if (!entry.isDirectory()) return;
    if (entry.name === ".git" || entry.name === "node_modules") return;

    const packageDirectory = path.join(directory, entry.name);
    const packageDefinition = readPackageDefinition(packageDirectory);

    if (packageDefinition) {
      // sampctl passes <dependencies>/<repo>/<include_path> to pawncc.
      // If include_path is unset, the package directory itself is used.
      const includePath = asString(packageDefinition.include_path);
      const includeDirectory = includePath
        ? resolvePath(includePath, packageDirectory)
        : packageDirectory;

      if (isDirectory(includeDirectory)) includeDirectories.add(includeDirectory);
      addPackageBuildIncludes(
        packageDefinition,
        packageDirectory,
        includeDirectories,
        compilerDirectories
      );
    } else {
      includeDirectories.add(packageDirectory);
    }

    walkDependencyDirectories(
      path.join(packageDirectory, "dependencies"),
      includeDirectories,
      compilerDirectories,
      visited,
      depth + 1
    );
  });
};

export interface ResolveIncludeConfigurationOptions {
  workspaceRoots: string[];
  customIncludePaths?: string[];
  compilerPath?: string;
}

export interface ResolveIncludeConfigurationResult {
  includeDirectories: string[];
  compilerDirectories: string[];
}

export const resolveIncludeConfiguration = (
  options: ResolveIncludeConfigurationOptions
): ResolveIncludeConfigurationResult => {
  const includeDirectories = new Set<string>();
  const compilerDirectories = new Set<string>();

  options.workspaceRoots.forEach((workspaceRoot) => {
    const root = path.resolve(workspaceRoot);
    if (!isDirectory(root)) return;

    // sampctl itself adds the package root to the compiler's include list.
    includeDirectories.add(root);

    [
      "include",
      "includes",
      "pawno/include",
      "qawno/include"
    ].forEach((relative) => {
      const directory = path.join(root, relative);
      if (isDirectory(directory)) includeDirectories.add(directory);
    });

    const packageDefinition = readPackageDefinition(root);
    if (packageDefinition) {
      addPackageBuildIncludes(
        packageDefinition,
        root,
        includeDirectories,
        compilerDirectories
      );

      const entry = asString(packageDefinition.entry);
      if (entry) {
        const entryDirectory = path.dirname(resolvePath(entry, root));
        if (isDirectory(entryDirectory)) includeDirectories.add(entryDirectory);
      }
    }

    // sampctl stores ensured dependencies below <package>/dependencies.
    walkDependencyDirectories(
      path.join(root, "dependencies"),
      includeDirectories,
      compilerDirectories,
      new Set<string>(),
      0
    );

    // Common local plugin/component folders can contain Pawn include packages.
    ["plugins", "components"].forEach((folder) => {
      walkDependencyDirectories(
        path.join(root, folder),
        includeDirectories,
        compilerDirectories,
        new Set<string>(),
        0
      );
    });

    // Standard Pawno/Qawno compiler installations.
    ["pawno", "qawno", "compiler", "bin"].forEach((relative) => {
      const directory = path.join(root, relative);
      if (isDirectory(directory)) {
        addCompilerDirectory(directory, compilerDirectories, includeDirectories);
      }
    });

    // Some legacy projects keep pawn.cfg at the workspace root.
    if (isFile(path.join(root, "pawn.cfg"))) {
      compilerDirectories.add(root);
    }
  });

  if (options.compilerPath) {
    options.workspaceRoots.forEach((root) => {
      addCompilerDirectory(
        resolvePath(options.compilerPath!, root),
        compilerDirectories,
        includeDirectories
      );
    });
  }

  compilerDirectories.forEach((directory) => {
    readPawnCfg(directory, includeDirectories);
  });

  options.customIncludePaths?.forEach((includePath) => {
    options.workspaceRoots.forEach((root) => {
      const resolved = resolvePath(includePath, root);
      if (isDirectory(resolved)) includeDirectories.add(resolved);
    });
  });

  return {
    includeDirectories: uniquePaths(includeDirectories),
    compilerDirectories: uniquePaths(compilerDirectories),
  };
};
