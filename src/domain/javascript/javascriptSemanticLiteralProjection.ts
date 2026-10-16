import { semanticExactResultOperand } from "./javascriptSemanticExpressionResults.js";
import * as t from "@babel/types";

import {
  semanticLiteralContainer,
  semanticLiteralProperty,
} from "./javascriptAstValues.js";
import { semanticPatternInitializationPrecedesRead } from "./javascriptSemanticEvaluationOrder.js";
import { semanticEffectTiming } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
} from "./javascriptSemanticPropertyPaths.js";
import type {
  JavaScriptSemanticAnalysisState,
  JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";

/** Resolve fresh-literal slots once, preserving capture order and iteration facts. */
export const semanticLiteralInitializerProjection = (
  initializer: JavaScriptSemanticInitializer,
  state: JavaScriptSemanticAnalysisState,
  onLiteralProjection?: () => void,
): JavaScriptSemanticInitializer | undefined => {
  const exactResult = (node: t.Node) => semanticExactResultOperand(node, state);
  let node = initializer.node;
  let projection = initializer.projection;
  while (projection.length > 0) {
    const key = projection[0];
    if (typeof key !== "string" && typeof key !== "number") return undefined;
    const container = semanticLiteralContainer(node, exactResult);
    if (container !== undefined) onLiteralProjection?.();
    if (typeof key === "number" && state.arrayIterationUnknown === true)
      return undefined;
    const capture = initializer.bindingNode ?? initializer.node;
    if (
      container !== undefined &&
      state.literalMemberEffects?.get(container)?.some((effect) => {
        const [affected] = effect.path;
        const affectsSlot =
          effect.path.length === 0 ||
          (effect.kind === "write" &&
            effect.path.length === 1 &&
            affected !== undefined &&
            (semanticPropertyPathKeyMatches(affected, String(key)) ||
              (t.isArrayExpression(container) &&
                semanticArrayIndex(key) !== null &&
                affected === "length")));
        if (!affectsSlot) return false;
        const patternOrder =
          effect.node === undefined
            ? undefined
            : semanticPatternInitializationPrecedesRead(
                capture,
                effect.node,
                state.parentsByNode,
              );
        return !(
          patternOrder ??
          semanticEffectTiming(capture, effect.node, state) === "after"
        );
      })
    )
      return undefined;
    const value = semanticLiteralProperty(node, key, exactResult);
    if (value === undefined) break;
    node = value;
    projection = projection.slice(1);
  }
  return { ...initializer, node, projection };
};
