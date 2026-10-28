import type { FeatureEnvironment } from './FeatureEnvironment.js';
import { ChannelPort } from './ChannelPort.js';
import { PageExperience } from './PageExperience.js';
/** 页面独占 Core/Adapter；只向业务暴露受关闭窗口保护的 call/subscribe。 */
export declare class ContainerClient {
    readonly pageId: string;
    readonly featureId: string;
    readonly port: ChannelPort;
    private readonly core;
    private phase;
    private closing?;
    readonly environment: FeatureEnvironment;
    readonly experience: PageExperience;
    constructor(pageId: string, featureId: string, port: ChannelPort, onError: (error: unknown) => void, command?: (command: string, id: string, payload: string) => void);
    get active(): boolean;
    private assertActive;
    ready(): Promise<void>;
    close(): Promise<void>;
}
