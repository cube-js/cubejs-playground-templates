const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generator = require('@babel/generator').default;
const prettier = require('prettier');

class SourceSnippet {
  static parse(source) {
    try {
      return parse(source, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript', 'classProperties', 'decorators-legacy'],
      });
    } catch (e) {
      throw new Error(`Can't parse source snippet: ${e.message}\n${source}`);
    }
  }

  static importsByAst(ast) {
    const imports = [];

    traverse(ast, {
      ImportDeclaration: (path) => {
        imports.push(path);
      },
    });

    return imports;
  }

  static definitionsByAst(ast) {
    const definitions = [];

    traverse(ast, {
      VariableDeclaration: (path) => {
        if (path.parent.type === 'Program') {
          definitions.push(path);
        }
      },
    });

    return definitions;
  }

  static formatCode(code, parser = 'babel') {
    try {
      return prettier.format(code, {
        parser,
        singleQuote: true,
      });
    } catch (error) {
      return code;
    }
  }

  static astToCode(ast, source = '') {
    return generator(
      ast,
      {
        decoratorsBeforeExport: true,
      },
      source
    ).code;
  }

  constructor(source = null, historySnippets = []) {
    if (source) {
      this.source = source;
    }
    this.historySnippets = historySnippets;
  }

  get source() {
    return SourceSnippet.astToCode(this.ast, this.sourceValue);
  }

  set source(source) {
    if (!source) {
      throw new Error('Empty source is provided');
    }

    this.sourceValue = source;
    this.ast = SourceSnippet.parse(source);
  }

  mergeImport(targetSource, importDeclaration) {
    const sameSourceImport = targetSource.imports.find(
      (i) =>
        i.get('source').node.value ===
          importDeclaration.get('source').node.value &&
        (i.get('specifiers')[0] && i.get('specifiers')[0].type) ===
          (importDeclaration.get('specifiers')[0] &&
            importDeclaration.get('specifiers')[0].type)
    );
    if (!sameSourceImport) {
      targetSource.imports[targetSource.imports.length - 1].insertAfter(
        importDeclaration.node
      );
      targetSource.findAllImports();
    } else {
      importDeclaration.get('specifiers').forEach((toInsert) => {
        const foundSpecifier = sameSourceImport
          .get('specifiers')
          .find(
            (existing) =>
              (existing.get('imported').node &&
                existing.get('imported').node.name) ===
                (toInsert.get('imported').node &&
                  toInsert.get('imported').node.name) &&
              (existing.get('local').node &&
                existing.get('local').node.name) ===
                (toInsert.get('local').node && toInsert.get('local').node.name)
          );
        if (!foundSpecifier) {
          sameSourceImport.pushContainer('specifiers', toInsert.node);
        }
      });
    }
  }

  insertAnchor(targetSource) {
    return targetSource.defaultExport;
  }

  mergeDefinition(targetSource, constDef, allHistoryDefinitions) {
    constDef.get('declarations').forEach((declaration) => {
      const existingDefinition = targetSource.definitions.find(
        (d) =>
          d.get('id').node.type === 'Identifier' &&
          declaration.get('id').node.type === 'Identifier' &&
          declaration.get('id').node.name === d.get('id').node.name
      );
      if (!existingDefinition) {
        this.insertAnchor(targetSource) &&
          this.insertAnchor(targetSource).insertBefore(
            t.variableDeclaration('const', [declaration.node])
          );
      } else {
        this.handleExistingMerge(
          existingDefinition,
          declaration,
          allHistoryDefinitions
        );
      }
    });
  }

  generateCode(path, comments) {
    if (!path.node) {
      return '';
    }
    if (path.node.type === 'VariableDeclarator') {
      path = path.parent;
    } else {
      path = path.node;
    }

    return SourceSnippet.formatCode(
      generator(
        t.program([path]),
        {
          comments: comments != null ? comments : true,
          decoratorsBeforeExport: true,
        },
        this.sourceValue
      ).code
    );
  }

  compareDefinitions(a, b) {
    return this.generateCode(a, false) === this.generateCode(b, false);
  }

  handleExistingMerge(
    existingDefinition,
    newDefinition,
    allHistoryDefinitions = []
  ) {
    const historyDefinitions = allHistoryDefinitions
      .map((definitions) =>
        definitions.find(
          (d) =>
            d.get('id').node.type === 'Identifier' &&
            existingDefinition.get('id').node.type === 'Identifier' &&
            existingDefinition.get('id').node.name === d.get('id').node.name
        )
      )
      .filter((d) => !!d);
    const lastHistoryDefinition =
      historyDefinitions.length &&
      historyDefinitions[historyDefinitions.length - 1];
    const newVariableDeclaration = t.variableDeclaration('const', [
      newDefinition.node,
    ]);
    if (
      !this.compareDefinitions(existingDefinition, lastHistoryDefinition) &&
      !this.compareDefinitions(existingDefinition, newDefinition)
    ) {
      t.addComment(
        newVariableDeclaration,
        'leading',
        `\n${this.generateCode(existingDefinition, false)}`
      );
    }
    if (existingDefinition.node.type === 'VariableDeclarator') {
      existingDefinition = existingDefinition.parentPath;
    }
    existingDefinition.replaceWith(newVariableDeclaration);
  }

  findImports() {
    return SourceSnippet.importsByAst(this.ast);
  }

  findDefinitions() {
    return SourceSnippet.definitionsByAst(this.ast);
  }

  mergeTo(targetSource) {
    const historyDefinitions = this.historySnippets.map((snippet) =>
      snippet
        .findDefinitions()
        .map((d) => d.get('declarations'))
        .reduce((a, b) => a.concat(b), [])
    );
    const imports = this.findImports();
    const definitions = this.findDefinitions();
    imports.forEach((i) => this.mergeImport(targetSource, i));
    definitions.forEach((d) =>
      this.mergeDefinition(targetSource, d, historyDefinitions)
    );

    targetSource.findAllImports();
    targetSource.findAllDefinitions();
  }
}

module.exports = SourceSnippet;
