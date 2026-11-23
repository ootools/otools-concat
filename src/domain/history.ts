/** 快照式撤销/重做栈（工程文档是纯 JSON，快照最简单可靠）。 */
export interface History<T> {
  /** 当前状态（由外部 reactive 传入引用，历史保存深拷贝）。 */
  get(): T;
  set(value: T): void;
  /** 提交一次变更：记录当前状态快照后应用变更。 */
  commit(mutate: (draft: T) => T): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
}

const LIMIT = 100;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createHistory<T>(get: () => T, set: (value: T) => void): History<T> {
  let past: T[] = [];
  let future: T[] = [];
  return {
    get,
    set,
    commit(mutate) {
      past.push(clone(get()));
      if (past.length > LIMIT) past.shift();
      future = [];
      set(mutate(get()));
    },
    undo() {
      const previous = past.pop();
      if (previous === undefined) return;
      future.push(clone(get()));
      set(previous);
    },
    redo() {
      const next = future.pop();
      if (next === undefined) return;
      past.push(clone(get()));
      set(next);
    },
    canUndo() {
      return past.length > 0;
    },
    canRedo() {
      return future.length > 0;
    },
    clear() {
      past = [];
      future = [];
    },
  };
}
