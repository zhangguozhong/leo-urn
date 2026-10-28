/** 容器错误与业务 Bridge 的协议错误分别保留，便于定位接入问题。 */
export class URNError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'URNError';
    }
}
