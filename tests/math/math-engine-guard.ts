/**
 * Static guard for math rendering: finds every way a source file can reach a
 * KaTeX/Temml renderer, so each one can be held to `safeKatexOptions`.
 *
 * Shapes recognized: default, aliased-default, named and namespace imports,
 * side-effect imports, `import x = require()`, re-exports, dynamic `import()`
 * and `require()`. Type-only imports and asset subpaths (CSS, fonts,
 * `package.json`) are ignored because they cannot render anything.
 *
 * Scope and known limits: the guard covers module imports of math engines,
 * plus KaTeX auto-render injected as script text. It does not see indirect or
 * global access: an engine reached through `globalThis.katex` / `window.katex`,
 * engine script URLs or code inside other HTML strings, or paths obtained with
 * `require.resolve`. Those need review.
 */
import ts from 'typescript';

/** Modules that render math (or wire a renderer into Markdown). */
const MATH_ENGINE_RE =
  /^(?:katex|temml|rehype-katex|rehype-mathjax|remark-math|react-katex|@matejmazur\/react-katex|@streamdown\/math|markdown-it-katex|markdown-it-texmath|mathjax|mathjax-full|better-react-mathjax)(?:\/.*)?$/;
const ASSET_SUBPATH_RE = /\.(?:css|json|woff2?|ttf|otf)$/;
/** Browser-global KaTeX auto-render, injected as script text rather than imported. */
const AUTO_RENDER_TEXT_RE = /renderMathInElement|contrib\/auto-render/;

const DIRECT_RENDER_ENGINES = new Set(['katex', 'temml']);

export interface EngineImport {
  specifier: string;
  line: number;
  /** How it was imported, for messages. */
  shape: string;
}

function isEngine(specifier: string): boolean {
  return MATH_ENGINE_RE.test(specifier) && !ASSET_SUBPATH_RE.test(specifier);
}

function parse(fileName: string, source: string): ts.SourceFile {
  const kind = /\.tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function stringArgument(call: ts.CallExpression): string | null {
  const [first] = call.arguments;
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

/** Every runtime import of a math engine in a file. */
export function findEngineImports(fileName: string, source: string): EngineImport[] {
  const file = parse(fileName, source);
  const found: EngineImport[] = [];
  const add = (specifier: string, node: ts.Node, shape: string) => {
    if (isEngine(specifier)) found.push({ specifier, line: lineOf(file, node), shape });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) add(node.moduleSpecifier.text, node, clause ? 'import' : 'side-effect import');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, node, 'import = require');
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text, node, 're-export');
    } else if (ts.isCallExpression(node)) {
      const specifier = stringArgument(node);
      if (specifier !== null) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          add(specifier, node, 'dynamic import');
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          add(specifier, node, 'require');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether the file injects KaTeX auto-render as script text. */
export function usesAutoRenderText(source: string): boolean {
  return AUTO_RENDER_TEXT_RE.test(source);
}

/** Where each render method takes its options. */
const OPTIONS_POSITION: Record<string, number> = {
  render: 2, // render(source, element, options)
  renderToString: 1, // renderToString(source, options)
  __renderToDomTree: 1,
  __renderToHTMLTree: 1,
};

/**
 * For a file allowed to import KaTeX/Temml directly. The engine may only be
 * bound through a static default or namespace import, and every use must be
 * `engine.<render method>(...)` whose options argument (at that method's own
 * position, with nothing after it) is a call to `safeKatexOptions` imported
 * from `@openmaic/dsl`. Returns violations.
 */
export function findUnsafeRenderUses(fileName: string, source: string): string[] {
  const file = parse(fileName, source);
  const violations: string[] = [];
  const engineBindings = new Set<string>();
  const safeBindings = new Set<string>();
  const at = (node: ts.Node) => `${fileName}:${lineOf(file, node)}`;

  for (const entry of findEngineImports(fileName, source)) {
    if (entry.shape !== 'import') {
      violations.push(
        `${fileName}:${entry.line} reaches ${entry.specifier} by ${entry.shape}; use a static default import`,
      );
    }
  }

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (specifier === '@openmaic/dsl' && clause && !clause.isTypeOnly) {
      const named = clause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && imported === 'safeKatexOptions') {
            safeBindings.add(element.name.text);
          }
        }
      }
      continue;
    }
    if (!isEngine(specifier) || !clause || clause.isTypeOnly) continue;
    if (!DIRECT_RENDER_ENGINES.has(specifier)) {
      violations.push(
        `${at(statement)} imports ${specifier}; only katex and temml may be used here`,
      );
      continue;
    }
    if (clause.name) engineBindings.add(clause.name.text);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) engineBindings.add(named.name.text);
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        violations.push(
          `${at(element)} binds ${element.getText(file)} from ${specifier}; use the default import`,
        );
      }
    }
  }

  const isSafeOptionsCall = (node: ts.Expression | undefined): boolean =>
    !!node &&
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    safeBindings.has(node.expression.text);

  const visit = (node: ts.Node): void => {
    // A local declaration shadowing the helper's name would not be the helper.
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      safeBindings.has(node.name.text)
    ) {
      violations.push(`${at(node)} redeclares ${node.name.text}`);
    }
    if (ts.isIdentifier(node) && engineBindings.has(node.text) && !isDeclarationName(node)) {
      const access = node.parent;
      const call = access?.parent;
      let ok = false;
      if (
        ts.isPropertyAccessExpression(access) &&
        access.expression === node &&
        access.name.text in OPTIONS_POSITION &&
        ts.isCallExpression(call) &&
        call.expression === access
      ) {
        const position = OPTIONS_POSITION[access.name.text];
        ok = call.arguments.length === position + 1 && isSafeOptionsCall(call.arguments[position]);
      }
      if (!ok) {
        violations.push(
          `${at(node)} uses ${node.text} other than as a render call with safeKatexOptions(...) options`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
    // `typeof katex` / `katex.KatexOptions` in type positions cannot render.
    ts.isTypeQueryNode(parent) ||
    ts.isQualifiedName(parent)
  );
}
