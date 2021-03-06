import {existsSync} from "fs";
import {readFile} from "fs/promises";
import {Octokit} from "@octokit/rest";
import {createLogger} from "@radiantpm/log";
import {
    AuthenticationCheckResponse,
    AuthenticationField,
    AuthenticationListValidResponse,
    AuthenticationLoginChangedResponse,
    DatabasePlugin,
    EnvironmentMetadata,
    MiddlewareError,
    PackageHandlerPlugin,
    PluginExport,
    Scope
} from "@radiantpm/plugin-types";
import {
    AuthPlugin,
    AuthPluginLoginResult,
    createAuthPlugin
} from "@radiantpm/plugin-utils";
import {SameSite, SetCookieOptions} from "@radiantpm/plugin-utils/req-utils";
import {name, version} from "../package.json";
import {AuthState} from "./types/AuthState";
import Configuration from "./types/Configuration";
import AuthContext from "./utils/AuthContext";
import {switchedScopeHandler} from "./utils/scope-handlers";

const logger = createLogger("plugin-github-auth");
const octokitLogger = createLogger("plugin-github-auth:octokit");

const validTokenRegex = /^ghp_[A-Za-z\d]+$/;

function getErrorMessage(err: unknown): string {
    if (err instanceof Error && !(err as MiddlewareError).isMessageSensitive) {
        return err.message;
    } else {
        return "Internal server error";
    }
}

let dbPlugin: DatabasePlugin;
let packageHandlers: PackageHandlerPlugin[];

interface OctokitMetadata {
    isDefault: boolean;
}

class GithubAuthPlugin implements AuthPlugin {
    private static readonly defaultOctokitOptions: Exclude<
        ConstructorParameters<typeof Octokit>[0],
        undefined
    > = {
        userAgent: `${name} ${version}`,
        log: {
            debug: (msg: string) => octokitLogger.debug("%s", msg),
            info: (msg: string) => octokitLogger.info("%s", msg),
            warn: (msg: string) => octokitLogger.warn("%s", msg),
            error: (msg: string) => octokitLogger.error("%s", msg)
        }
    };

    private static octokitMetadata = new WeakMap<Octokit, OctokitMetadata>();

    id = "github-auth";
    displayName = "Github";
    accessTokenCookieName = "auth-token";
    accessTokenCookieOptions: SetCookieOptions = {
        expires: new Date(Date.now() + 18144000000 /* 1 month */),
        httpOnly: true,
        sameSite: SameSite.strict,
        path: "/"
    };

    constructor(private readonly config: Configuration) {}

    async check(
        accessToken: string | null,
        scope: Scope
    ): Promise<AuthenticationCheckResponse> {
        const octokit = await this.getOctokit(accessToken);
        const authState = await this.getAuthState(octokit);
        const context = new AuthContext({
            octokit,
            dbPlugin,
            authState,
            packageHandlers
        });

        try {
            return await switchedScopeHandler.check(
                scope,
                this.config,
                context
            );
        } catch (err) {
            return {
                success: false,
                errorMessage: getErrorMessage(err)
            };
        }
    }

    async listValid(
        accessToken: string | null,
        scopeKind: Scope["kind"]
    ): Promise<AuthenticationListValidResponse> {
        const octokit = await this.getOctokit(accessToken);
        const authState = await this.getAuthState(octokit);
        const context = new AuthContext({
            octokit,
            dbPlugin,
            authState,
            packageHandlers
        });

        try {
            return await switchedScopeHandler.listValid(
                scopeKind,
                this.config,
                context
            );
        } catch (err) {
            return {
                validObjects: [],
                errorMessage: getErrorMessage(err)
            };
        }
    }

    getFields(): AuthenticationField[] {
        return [
            {
                name: "access-token",
                label: "Access Token",
                type: "text",
                description:
                    "An access token from Github, with the `repo` scope if you are using private repositories"
            }
        ];
    }

    async onLogin(
        fields: Record<string, string>
    ): Promise<AuthPluginLoginResult> {
        const accessToken = fields["access-token"];

        if (!accessToken) {
            return {
                success: false,
                errorMessage: "No access token provided"
            };
        }

        const octokit = await this.getOctokit(accessToken);

        try {
            await octokit.users.getAuthenticated();

            return {
                success: true,
                accessToken
            };
        } catch (err) {
            if (err instanceof Error && err.message === "Bad credentials") {
                return {
                    success: false,
                    errorMessage: "Invalid access token"
                };
            } else {
                throw err;
            }
        }
    }

    onLoginChanged(
        fields: Record<string, string>
    ): AuthenticationLoginChangedResponse {
        const accessToken = fields["access-token"];

        if (!accessToken) {
            return {
                valid: false,
                errors: [
                    {
                        field: "access-token",
                        message: "Missing"
                    }
                ]
            };
        } else if (!validTokenRegex.test(accessToken)) {
            return {
                valid: false,
                errors: [
                    {
                        field: "access-token",
                        message: "Incorrect format"
                    }
                ]
            };
        }

        return {
            valid: true
        };
    }

    private async getOctokit(accessToken?: string | null) {
        if (accessToken) {
            const octokit = new Octokit({
                ...(GithubAuthPlugin.defaultOctokitOptions as Record<
                    string,
                    unknown
                >),
                auth: accessToken
            });

            // todo: send a request to make sure the token works
            GithubAuthPlugin.octokitMetadata.set(octokit, {
                isDefault: false
            });

            return octokit;
        } else {
            const defaultAccessToken = await this.getDefaultAccessToken();

            const octokit = new Octokit({
                ...(GithubAuthPlugin.defaultOctokitOptions as Record<
                    string,
                    unknown
                >),
                auth: defaultAccessToken
            });

            GithubAuthPlugin.octokitMetadata.set(octokit, {
                isDefault: true
            });

            return octokit;
        }
    }

    private async getAuthState(octokit: Octokit): Promise<AuthState> {
        if (this.isLoggedIn(octokit)) {
            return {
                isLoggedIn: false
            };
        } else {
            try {
                const user = await octokit.rest.users.getAuthenticated();

                return {
                    isLoggedIn: true,
                    username: user.data.login
                };
            } catch (err) {
                logger.trace(
                    err,
                    "Failed to check the user authentication status; counting as unauthenticated"
                );

                return {isLoggedIn: false};
            }
        }
    }

    private isLoggedIn(octokit: Octokit) {
        return (
            GithubAuthPlugin.octokitMetadata.get(octokit)?.isDefault === false
        );
    }

    private async getDefaultAccessToken() {
        if (!existsSync(this.config.accessTokenFilename)) {
            throw new Error("Github default access token file does not exist");
        }

        const source = await readFile(this.config.accessTokenFilename, "utf8");
        return source.trim();
    }
}

const pluginExport: PluginExport<Configuration, true> = {
    configIsRequired: true,
    configSchema: {
        type: "object",
        required: ["accessTokenFilename", "feedCreators"],
        properties: {
            accessTokenFilename: {
                type: "string"
            },
            feedCreators: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        }
    },
    provides: {
        authentication: "github-auth"
    },
    init(config) {
        return createAuthPlugin(new GithubAuthPlugin(config));
    },
    onMetaLoaded(meta: EnvironmentMetadata) {
        dbPlugin = meta.selectedPlugins.database;

        packageHandlers = meta.plugins.filter(
            pl => pl.type === "package-handler"
        ) as PackageHandlerPlugin[];
    }
};

export default pluginExport;
