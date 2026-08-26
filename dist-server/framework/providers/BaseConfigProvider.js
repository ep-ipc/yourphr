export class BaseConfigProvider {
    /**
     * The storage roots this provider was built over, as environment names (yourphr#626). The manager
     * seeds `${VAR}` resolution with these so a path template resolves against the root actually in
     * use — including a test's temporary directory, which no environment variable names. A real
     * environment variable of the same name still wins.
     */
    roots() { return {}; }
}
//# sourceMappingURL=BaseConfigProvider.js.map