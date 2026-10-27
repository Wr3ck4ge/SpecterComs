// Not rendered in the engine test: only the module-level engine is exercised.
export const useCallback = (fn) => fn;
export const useEffect = () => {};
export const useRef = (v) => ({ current: v });
export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}];
