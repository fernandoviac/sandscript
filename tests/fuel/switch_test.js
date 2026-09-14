import {
  assertNumericResult,
  assertStringResult,
  assertBooleanResult,
  assertArrayResult,
  assertErrorCode,
  createTestContext,
  runCode,
  getNumericVar,
  getStringVar,
  assertEquals,
  assert,
  STATUS_DONE,
  STATUS_ERROR,
} from './interpreter-test-utils.js';
import { EXIT_DONE, EXIT_ERROR } from '../../src/fuel/index.js';

Deno.test("switch: basic match on first case", () => {
  assertNumericResult(`
    let r = 0;
    switch (1) {
      case 1:
        r = 10;
        break;
      case 2:
        r = 20;
        break;
    }
  `, 'r', 10);
});

Deno.test("switch: basic match on second case", () => {
  assertNumericResult(`
    let r = 0;
    switch (2) {
      case 1:
        r = 10;
        break;
      case 2:
        r = 20;
        break;
    }
  `, 'r', 20);
});

Deno.test("switch: no match, no default — nothing executes", () => {
  assertNumericResult(`
    let r = 99;
    switch (3) {
      case 1:
        r = 10;
        break;
      case 2:
        r = 20;
        break;
    }
  `, 'r', 99);
});

Deno.test("switch: default clause executes when no case matches", () => {
  assertNumericResult(`
    let r = 0;
    switch (3) {
      case 1:
        r = 10;
        break;
      default:
        r = 99;
        break;
    }
  `, 'r', 99);
});

Deno.test("switch: fall-through without break", () => {
  assertNumericResult(`
    let r = 0;
    switch (1) {
      case 1:
        r = r + 1;
      case 2:
        r = r + 10;
      case 3:
        r = r + 100;
    }
  `, 'r', 111);
});

Deno.test("switch: break stops fall-through", () => {
  assertNumericResult(`
    let r = 0;
    switch (1) {
      case 1:
        r = r + 1;
        break;
      case 2:
        r = r + 10;
      case 3:
        r = r + 100;
    }
  `, 'r', 1);
});

Deno.test("switch: fall-through into default", () => {
  assertNumericResult(`
    let r = 0;
    switch (2) {
      case 1:
        r = r + 1;
        break;
      case 2:
        r = r + 10;
      default:
        r = r + 100;
    }
  `, 'r', 110);
});

Deno.test("switch: default in the middle", () => {
  assertNumericResult(`
    let r = 0;
    switch (99) {
      case 1:
        r = r + 1;
        break;
      default:
        r = r + 10;
      case 3:
        r = r + 100;
    }
  `, 'r', 110);
});

Deno.test("switch: default in the middle, matched case after default", () => {
  assertNumericResult(`
    let r = 0;
    switch (3) {
      case 1:
        r = r + 1;
        break;
      default:
        r = r + 10;
      case 3:
        r = r + 100;
        break;
    }
  `, 'r', 100);
});

Deno.test("switch: default in the middle, fall-through from case above into default and beyond", () => {
  assertNumericResult(`
    let r = 0;
    switch (1) {
      case 1:
        r = r + 1;
      default:
        r = r + 10;
      case 3:
        r = r + 100;
    }
  `, 'r', 111);
});

Deno.test("switch: empty case (grouping pattern)", () => {
  assertNumericResult(`
    let r = 0;
    switch (2) {
      case 1:
      case 2:
      case 3:
        r = 10;
        break;
      default:
        r = 99;
    }
  `, 'r', 10);
});

Deno.test("switch: expression case tests", () => {
  assertNumericResult(`
    let x = 5;
    let r = 0;
    switch (x * 2) {
      case 5 + 5:
        r = 1;
        break;
      case 5 + 4:
        r = 2;
        break;
    }
  `, 'r', 1);
});

Deno.test("switch: string discriminant", () => {
  assertStringResult(`
    let r = "";
    switch ("hello") {
      case "hi":
        r = "hi";
        break;
      case "hello":
        r = "hello";
        break;
      default:
        r = "other";
    }
  `, 'r', "hello");
});

Deno.test("switch: case test side effects — evaluation stops at first match", () => {
  assertNumericResult(`
    let count = 0;
    function inc() { count = count + 1; return 2; }
    switch (1) {
      case 1:
        break;
      case inc():
        break;
    }
  `, 'count', 0);
});

Deno.test("switch: case test side effects — evaluated top-to-bottom", () => {
  assertNumericResult(`
    let count = 0;
    function inc() { count = count + 1; return 2; }
    switch (2) {
      case inc():
        break;
      case inc():
        break;
    }
  `, 'count', 1);
});

Deno.test("switch: nested switch", () => {
  assertNumericResult(`
    let r = 0;
    switch (1) {
      case 1:
        switch (2) {
          case 2:
            r = 42;
            break;
          default:
            r = 0;
        }
        break;
      default:
        r = -1;
    }
  `, 'r', 42);
});

Deno.test("switch: nested switch — inner break doesn't exit outer", () => {
  assertNumericResult(`
    let r = 0;
    switch (1) {
      case 1:
        switch (2) {
          case 2:
            r = r + 1;
            break;
        }
        r = r + 10;
        break;
      case 2:
        r = r + 100;
    }
  `, 'r', 11);
});

Deno.test("switch: inside a loop — break targets switch, not loop", () => {
  assertNumericResult(`
    let r = 0;
    for (let i = 0; i < 3; i = i + 1) {
      switch (i) {
        case 0:
          r = r + 1;
          break;
        case 1:
          r = r + 10;
          break;
        default:
          r = r + 100;
          break;
      }
    }
  `, 'r', 111);
});

Deno.test("switch: continue inside switch in a loop targets the loop", () => {
  assertNumericResult(`
    let r = 0;
    for (let i = 0; i < 5; i = i + 1) {
      switch (i) {
        case 2:
          continue;
        default:
          r = r + 1;
      }
    }
  `, 'r', 4);
});

Deno.test("switch: return inside switch in a function", () => {
  assertNumericResult(`
    function f(x) {
      switch (x) {
        case 1: return 10;
        case 2: return 20;
        default: return 99;
      }
    }
    let r = f(2);
  `, 'r', 20);
});

Deno.test("switch: scoping — let in one case is visible in fall-through", () => {
  assertNumericResult(`
    let r = 0;
    switch (1) {
      case 1:
        let x = 5;
      case 2:
        r = x;
    }
  `, 'r', 5);
});

Deno.test("switch: scoping — block-scoped cases are independent", () => {
  assertNumericResult(`
    let r = 0;
    switch (2) {
      case 1: {
        let x = 5;
        r = x;
        break;
      }
      case 2: {
        let x = 10;
        r = x;
        break;
      }
    }
  `, 'r', 10);
});

Deno.test("switch: strict equality — no coercion", () => {
  assertStringResult(`
    let r = "none";
    switch (1) {
      case true:
        r = "true";
        break;
      case 1:
        r = "one";
        break;
    }
  `, 'r', "one");
});

Deno.test("switch: only default clause", () => {
  assertNumericResult(`
    let r = 0;
    switch (42) {
      default:
        r = 1;
    }
  `, 'r', 1);
});

Deno.test("switch: empty switch body", () => {
  assertNumericResult(`
    let r = 99;
    switch (1) {}
  `, 'r', 99);
});
