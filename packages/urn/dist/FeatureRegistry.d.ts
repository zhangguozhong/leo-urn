import type { FeatureDefinition, ResolvedFeature } from './FeatureDefinition.js';
export declare class FeatureRegistry {
    private readonly entries;
    get size(): number;
    register<P>(definition: FeatureDefinition<P>): this;
    resolve(id: string, raw: unknown): ResolvedFeature;
}
