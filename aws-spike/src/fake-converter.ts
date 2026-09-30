import type { Clock, Converter, RunningConversion } from "../../src/worker.ts";

/**
 * Stands in for the real converters, which are not available here: the import side is a TypeScript
 * library and the export side a vendor JVM binary.
 *
 * The exit code is taken from the input filename, so a run can be steered from the submit script:
 *
 *   uploads/ok.mdb        exits 0    success
 *   uploads/corrupt.mdb   exits 2    invalid database, permanent
 *   uploads/oom.mdb       exits 137  killed, transient
 *   uploads/slow.mdb      never finishes, to exercise the timeout and the kill
 */
export class FakeConverter implements Converter {
  kills = 0;

  start(inputKey: string, outputKey: string): RunningConversion {
    console.log(`    converter started: ${inputKey} -> ${outputKey}`);

    if (inputKey.includes("slow")) {
      return {
        completion: new Promise<number>(() => {}), // never settles
        kill: async () => {
          this.kills += 1;
          console.log("    converter killed and reaped");
        },
      };
    }

    const code = inputKey.includes("corrupt") ? 2 : inputKey.includes("oom") ? 137 : 0;
    return {
      completion: new Promise<number>((resolve) => setTimeout(() => resolve(code), 300)),
      kill: async () => {
        this.kills += 1;
      },
    };
  }
}

/** Real timers, so the worker's timeout behaves as it would in production. */
export class RealClock implements Clock {
  timeout(ms: number): Promise<never> {
    return new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`conversion timed out after ${ms}ms`)), ms),
    );
  }
}
