import type { FeatureDefinition, ResolvedFeature, FeatureModule, FeaturePreflight } from './FeatureDefinition.js';
export declare class FeatureRegistry {
    private readonly modules;
    private readonly entries;
    manifest(id: string): FeatureModule | undefined;
    get size(): number;
    register<P>(definition: FeatureDefinition<P>): this;
    resolve(id: string, raw: unknown, host?: FeaturePreflight): ResolvedFeature;
}
