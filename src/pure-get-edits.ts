import { diffLines } from "diff";
import * as path from "path";
import { headingToAnchor } from "./heading-to-anchor";
import minimatch from "minimatch";
import {
  ChangeEvent,
  ChangeEventPayload,
  ChangeEventType,
  Edit,
  FileList,
  isEventOfType,
} from "./models";


const wikilinkRegex = /(\[\[)([^\)]+?)(#[^\s\/]+)?\]\]/gm;
const mdLinkRegex = /\[([^\]]*)\]\(([^\)]+)\)/;
const mdLinkRegexGlobal = /(\[[^\]]*\]\()([^\)]+?)(#[^\s\/]+)?\)/gm;
const imgRegex = /(<img\s[^>]*?src\s*=\s*['\"])([^'\"]*?)['\"][^>]*?>/gm;

interface Options {
  /**
   * Array of glob patterns used to exclude specific folders and files.
   */
  exclude?: string[];
  /**
   * Array of glob patterns used to include specific folders and files.
   * If the array is empty, everything will be included, unless specified by exclude.
   */
  include?: string[];
  /**
   * The absolute path of the VS Code workspace.
   */
  workspacePath?: string;
}

function pureGetEdits<T extends ChangeEventType>(
  event: ChangeEvent<T>,
  markdownFiles: FileList,
  options: Options
) {
  const result = (() => {
    if (isEventOfType(event, "save")) {
      return [...handleSaveEvent(event.payload, options)];
    } else if (isEventOfType(event, "rename")) {
      return [...handleRenameEvent(event.payload, markdownFiles, options)];
    } else {
      return [];
    }
  })();

  return result;
}
function* handleRenameEvent(
  payload: ChangeEventPayload["rename"],
  markdownFiles: FileList,
  { exclude = [], include = [], workspacePath }: Options
): Generator<Edit> {
  const pathBefore = path.posix.normalize(windowsToPosix(payload.pathBefore));
  const pathAfter = path.posix.normalize(windowsToPosix(payload.pathAfter));

  const shouldIncludePath = (filePath: string) => {
    const relativePath = path.posix.relative(workspacePath ?? "", filePath);

    const matchesIncludeList = include.some((pattern) => {
      return minimatch(relativePath, pattern);
    });

    if (matchesIncludeList) {
      return true;
    }

    if (include.length > 0) {
      return false;
    }

    const matchesExcludeList = exclude.some((pattern) => {
      return minimatch(relativePath, pattern);
    });

    return !matchesExcludeList;
  };

  markdownFiles = markdownFiles
    .map((file) => ({ ...file, path: windowsToPosix(file.path) }))
    .filter(({ path }) => shouldIncludePath(path));

  if (!shouldIncludePath(pathBefore)) {
    return;
  }

  const fileContent = markdownFiles.find(
    (file) => path.posix.normalize(file.path) === pathAfter
  )?.content;

  for (const { target, line, col } of getAllLinks(fileContent)) {
    const absoluteTarget = path.posix.join(
      path.posix.dirname(pathBefore),
      target
    );

    const newLink = path.posix.normalize(
      path.posix.relative(path.posix.dirname(pathAfter), absoluteTarget)
    );

    const targetIsUnmodified = path.posix.normalize(target) === newLink;

    if (targetIsUnmodified) {
      continue;
    }

    yield {
      path: pathAfter,
      range: {
        start: {
          line,
          character: col,
        },
        end: {
          line: line,
          character: col + target.length,
        },
      },
      newText: newLink,
      requiresPathToExist: absoluteTarget,
    };
  }

  for (const markdownFile of markdownFiles) {
    for (const { target, line, col, replaceFileExtension } of getAllLinks(markdownFile.content)) {
      let absoluteTarget = path.posix.normalize(
        path.posix.join(path.posix.dirname(markdownFile.path), target)
      );

      if(!replaceFileExtension) {
        // let extensionInLink = absoluteTarget.slice(0, -3);
        if(!absoluteTarget.includes('.md')) {
          absoluteTarget += '.md';
        }
      }

      const isLinkToFileInRenamedFolder = absoluteTarget.startsWith(
        pathBefore + path.posix.sep
      );

      const isLinkToMovedFile = absoluteTarget === pathBefore;

      if (isLinkToMovedFile) {
        let newLink = path.posix.normalize(
          path.posix.relative(path.posix.dirname(markdownFile.path), pathAfter)
        );

        if(!replaceFileExtension) {
          if(!target.includes('.md')) {
            newLink = newLink.slice(0, -3);
          }
        }

        yield {
          path: markdownFile.path,
          range: {
            start: {
              line,
              character: col,
            },
            end: {
              line: line,
              character: col + target.length,
            },
          },
          newText: newLink,
        };
      } else if (isLinkToFileInRenamedFolder) {
        const newAbsoluteTarget = `${pathAfter}/${absoluteTarget.substring(
          pathBefore.length + 1
        )}`;

        let newLink = path.posix.relative(
          path.posix.dirname(markdownFile.path),
          newAbsoluteTarget
        );

        if(!replaceFileExtension) {
          newLink = newLink.slice(0, -3);
        }

        yield {
          path: markdownFile.path,
          range: {
            start: {
              line,
              character: col,
            },
            end: {
              line,
              character: col + target.length,
            },
          },
          newText: newLink,
          requiresPathToExist: newAbsoluteTarget,
        };
      }
    }
  }
}

function* handleSaveEvent(
  payload: ChangeEventPayload["save"],
  { exclude }: Options
): Generator<Edit> {
  const { contentBefore, contentAfter } = payload;

  const diff = diffLines(contentBefore, contentAfter, {});
  const renamedHeadings = diff
    .map((change, index) => {
      const nextChange = diff[index + 1];

      if (!nextChange) {
        return null;
      }

      const removedAndAddedLine =
        change.removed === true && nextChange.added === true;

      if (removedAndAddedLine) {
        const oldLine = change.value;
        const newLine = nextChange.value;

        const headingRegex = /^(#+ )(.+)/;
        const oldLineMatch = oldLine.match(headingRegex);
        const newLineMatch = newLine.match(headingRegex);

        if (
          oldLineMatch &&
          newLineMatch &&
          // Check if same header type
          oldLineMatch[1] === newLineMatch[1]
        ) {
          return {
            oldHeader: oldLineMatch[2],
            newHeader: newLineMatch[2],
          };
        }
      }

      return null;
    })
    .filter(Boolean) as Array<{ oldHeader: string; newHeader: string }>;

  let lineNumber = 0;
  for (const line of contentAfter.split("\n")) {
    const [match, name, link] = line.match(mdLinkRegex) ?? [];

    if (match) {
      for (const { oldHeader, newHeader } of renamedHeadings) {
        const oldHeaderAnchor = headingToAnchor(oldHeader);
        const newHeaderAnchor = headingToAnchor(newHeader);

        if (link === `#${oldHeaderAnchor}`) {
          yield {
            path: payload.path,
            range: {
              start: {
                line: lineNumber,
                character: 0,
              },
              end: {
                line: lineNumber,
                character: line.length,
              },
            },
            newText: `[${name}](#${newHeaderAnchor})`,
          };
        }
      }
    }

    lineNumber++;
  }
}

function* getAllLinks(fileContent: string | undefined) {
  yield* getMatchingLinks(mdLinkRegexGlobal, fileContent, true);
  yield* getMatchingLinks(imgRegex, fileContent, true);
  yield* getMatchingLinks(wikilinkRegex, fileContent, false);
}

function* getMatchingLinks(regex: RegExp, fileContent: string | undefined, replaceFileExtension: boolean) {
  if (!fileContent) {
    return;
  }

  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(fileContent)) !== null) {
    let [_, prefix, target] = match;
    target = windowsToPosix(target);
    const index = match.index + prefix.length;
    const lines = fileContent.substring(0, index).split("\n");
    const line = lines.length - 1;
    const col = lines[line].length;

    yield {
      target,
      line,
      col,
      replaceFileExtension
    };
  }
}

const windowsToPosix = (path: string) => {
  return path.replace(/\\/g, "/");
};

export { pureGetEdits, Options };
