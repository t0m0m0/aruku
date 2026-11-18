export let debugPrint: (message: string | null) => void = (message) => {
  console.log(message);
};

export function setDebugPrint(fn: (message: string | null) => void): void {
  debugPrint = fn;
}
