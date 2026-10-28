/** 容器错误与业务 Bridge 的协议错误分别保留，便于定位接入问题。 */
export declare class URNError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
