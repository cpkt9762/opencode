import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import h from "solid-js/h"
import type { LocalProject } from "@/context/layout"
import type { WorkspaceSidebarContext } from "./sidebar-workspace"

let LocalWorkspace: typeof import("./sidebar-workspace").LocalWorkspace
let SortableWorkspace: typeof import("./sidebar-workspace").SortableWorkspace
let stableProject: typeof import("./sidebar-workspace").stableProject

globalThis.React = {
  createElement: h,
  Fragment: h.Fragment,
} as unknown as typeof globalThis.React

const ctx: WorkspaceSidebarContext = {
  currentDir: () => "",
  navList: () => [],
  sidebarExpanded: () => true,
  sidebarHovering: () => false,
  clearHoverProjectSoon: () => {},
  prefetchSession: () => {},
  archiveSession: async () => {},
  workspaceName: () => undefined,
  renameWorkspace: () => {},
  editorOpen: () => false,
  openEditor: () => {},
  closeEditor: () => {},
  setEditor: () => {},
  InlineEditor: () => null,
  isBusy: () => false,
  workspaceExpanded: () => false,
  setWorkspaceExpanded: () => {},
  showResetWorkspaceDialog: () => {},
  showDeleteWorkspaceDialog: () => {},
  setScrollContainerRef: () => {},
}

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@tanstack/solid-query", () => ({
    useQuery: (options: () => unknown) => {
      createEffect(options)
      return { isPending: false }
    },
  }))
  mock.module("@/context/global-sync", () => ({
    loadSessionsQuery: () => ({ queryKey: ["sessions"], queryFn: async () => [] }),
    useGlobalSync: () => ({
      child: () => [
        {
          status: "complete",
          session: [],
          sessionTotal: 0,
          vcs: undefined,
        },
        () => {},
      ],
      project: {
        loadSessions: async () => undefined,
      },
    }),
  }))
  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))
  mock.module("@thisbeyond/solid-dnd", () => ({
    createSortable: () => ({ isActiveDraggable: false }),
  }))
  mock.module("@solid-primitives/media", () => ({
    createMediaQuery: () => () => false,
  }))
  mock.module("@opencode-ai/ui/button", () => ({
    Button: (props: { children?: unknown }) => props.children,
  }))
  mock.module("@opencode-ai/ui/collapsible", () => ({
    Collapsible: Object.assign(
      (props: { children?: unknown }) => props.children,
      {
        Trigger: (props: { children?: unknown }) => props.children,
        Content: (props: { children?: unknown }) => props.children,
      },
    ),
  }))
  mock.module("@opencode-ai/ui/dropdown-menu", () => ({
    DropdownMenu: Object.assign(
      (props: { children?: unknown }) => props.children,
      {
        Trigger: (props: { children?: unknown }) => props.children,
        Portal: (props: { children?: unknown }) => props.children,
        Content: (props: { children?: unknown }) => props.children,
        Item: (props: { children?: unknown }) => props.children,
        ItemLabel: (props: { children?: unknown }) => props.children,
      },
    ),
  }))
  mock.module("@opencode-ai/ui/icon", () => ({ Icon: () => null }))
  mock.module("@opencode-ai/ui/icon-button", () => ({ IconButton: () => null }))
  mock.module("@opencode-ai/ui/spinner", () => ({ Spinner: () => null }))
  mock.module("@opencode-ai/ui/tooltip", () => ({
    Tooltip: (props: { children?: unknown }) => props.children,
  }))
  mock.module("./sidebar-items", () => ({
    NewSessionItem: () => null,
    SessionItem: () => null,
    SessionSkeleton: () => null,
  }))
  mock.module("./helpers", () => ({
    sortedRootSessions: () => [],
    workspaceKey: (value: string) => value,
  }))

  const mod = await import("./sidebar-workspace")
  LocalWorkspace = mod.LocalWorkspace
  SortableWorkspace = mod.SortableWorkspace
  stableProject = mod.stableProject
})

const project = (): LocalProject => ({
  id: "project-1",
  worktree: "/tmp/project",
  expanded: true,
})

describe("workspace sidebar project stability", () => {
  test("keeps the previous project during transient undefined updates", () => {
    expect(stableProject(undefined, project())).toEqual(project())
    expect(stableProject(project(), undefined)).toEqual(project())
  })

  test("LocalWorkspace survives project accessor turning undefined after mount", () => {
    createRoot((dispose) => {
      const [value, setValue] = createSignal<LocalProject | undefined>(project())

      LocalWorkspace({
        ctx,
        get project() {
          return value() as LocalProject
        },
        sortNow: () => 0,
      })

      expect(() => setValue(undefined)).not.toThrow()
      dispose()
    })
  })

  test("SortableWorkspace survives project accessor turning undefined after mount", () => {
    createRoot((dispose) => {
      const [value, setValue] = createSignal<LocalProject | undefined>(project())

      SortableWorkspace({
        ctx,
        directory: "/tmp/project",
        get project() {
          return value() as LocalProject
        },
        sortNow: () => 0,
      })

      expect(() => setValue(undefined)).not.toThrow()
      dispose()
    })
  })
})
