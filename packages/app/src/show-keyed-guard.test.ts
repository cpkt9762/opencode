import { describe, test } from "bun:test"
import { join, relative, resolve } from "node:path"
import * as ts from "typescript"

const scan = async (dir: string) =>
  Promise.all(
    Array.from(new Bun.Glob("**/*.tsx").scanSync({ cwd: dir })).map(async (file) => {
      const full = join(dir, file)
      return {
        file: full,
        text: await Bun.file(full).text(),
      }
    }),
  )

const find = (file: string, text: string, root: string) => {
  const hits: string[] = []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  const walk = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "Show") {
      const keyed = node.openingElement.attributes.properties.some(
        (prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === "keyed",
      )
      const child = node.children.find((child) => {
        if (ts.isJsxText(child)) return child.getText(source).trim() !== ""
        if (ts.isJsxExpression(child)) return child.expression !== undefined
        return true
      })

      if (
        !keyed &&
        child &&
        ts.isJsxExpression(child) &&
        child.expression &&
        ts.isArrowFunction(child.expression) &&
        child.expression.parameters.length > 0
      ) {
        hits.push(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`)
      }
    }

    ts.forEachChild(node, walk)
  }

  walk(source)
  return hits
}

describe("show keyed guard", () => {
  test("app and desktop show callbacks are keyed", async () => {
    const root = resolve(import.meta.dir, "../../..")
    const hits = (await Promise.all([scan(import.meta.dir), scan(resolve(import.meta.dir, "../../desktop/src"))]))
      .flat()
      .flatMap((item) => find(item.file, item.text, root))

    if (hits.length > 0) {
      throw new Error(`non-keyed <Show> callbacks found:\n${hits.join("\n")}`)
    }
  })
})
