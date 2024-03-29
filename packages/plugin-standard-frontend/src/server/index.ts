import assert from "assert";
import {dirname, join} from "path";
import {fileURLToPath} from "url";
import {fillUrl} from "@radiantpm/bfutils";
import {getSerialisablePlugin} from "@radiantpm/frontend-utilities";
import {createLogger} from "@radiantpm/log";
import {
    AssetUrlParams,
    AuthenticationPlugin,
    DatabasePlugin,
    EnvironmentMetadata,
    FileCategory,
    HttpRequest,
    MiddlewarePlugin,
    PluginExport,
    StoragePlugin,
    ValidationPlugin
} from "@radiantpm/plugin-types";
import {createRouteMiddlewarePlugin} from "@radiantpm/plugin-utils";
import serveStatic from "@radiantpm/serve-static";
import {renderPage} from "vite-plugin-ssr";
import {Configuration} from "~/types/Configuration";
import {PageContext} from "~/renderer/types";
import {onlyKeys} from "~/utils/onlyKeys";

const logger = createLogger("plugin-standard-frontend");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let runExpressMiddlewareSymbol: symbol;
let authenticationPlugin: AuthenticationPlugin;
let databasePlugin: DatabasePlugin;
let storagePlugins: {[key in FileCategory]: StoragePlugin};
let validationPlugin: ValidationPlugin;

function shouldHandle(req: HttpRequest) {
    return (
        !req.url.pathname.startsWith("/-/") &&
        !req.url.pathname.startsWith("/api/") &&
        !req.url.pathname.startsWith("/.")
    );
}

interface RequiredMetadata {
    backend: {
        data: {
            std01: {
                readonly runExpressMiddlewareSymbol: unique symbol;
            };
        };
    };
}

const pluginExport: PluginExport<Configuration, true> = {
    configIsRequired: true,
    loadBefore: "@radiantpm/plugin-default-response",
    configSchema: {
        type: "object",
        required: ["favicon", "logo", "logoText"],
        additionalProperties: false,
        properties: {
            gzip: {
                type: "boolean",
                nullable: true,
                default: false
            },
            favicon: {
                type: "object",
                required: ["light", "dark", "default"],
                additionalProperties: false,
                properties: {
                    light: {
                        type: "string",
                        pattern: "[a-z.-]+"
                    },
                    dark: {
                        type: "string",
                        pattern: "[a-z.-]+"
                    },
                    default: {
                        type: "string",
                        pattern: "[a-z.-]+"
                    }
                }
            },
            logo: {
                type: "object",
                required: ["light", "dark"],
                additionalProperties: false,
                properties: {
                    light: {
                        type: "string",
                        pattern: "[a-z.-]+"
                    },
                    dark: {
                        type: "string",
                        pattern: "[a-z.-]+"
                    }
                }
            },
            logoText: {
                type: "object",
                required: ["light", "dark"],
                additionalProperties: false,
                properties: {
                    light: {
                        type: "string",
                        pattern: "[a-z.-]+"
                    },
                    dark: {
                        type: "string",
                        pattern: "[a-z.-]+"
                    }
                }
            }
        }
    },

    onMetaLoaded(meta: EnvironmentMetadata & RequiredMetadata) {
        assert(
            meta.backend.data.std01,
            "Incompatible backend server. Must support `std01`."
        );

        const serverData = meta.backend.data.std01;

        assert(
            serverData.runExpressMiddlewareSymbol,
            "Missing RExM symbol on server data"
        );

        runExpressMiddlewareSymbol = serverData.runExpressMiddlewareSymbol;

        authenticationPlugin = meta.selectedPlugins.authentication;
        databasePlugin = meta.selectedPlugins.database;
        storagePlugins = meta.selectedPlugins.storage;
        validationPlugin = meta.selectedPlugins.validation;
    },

    async init(config: Configuration): Promise<MiddlewarePlugin[]> {
        const plugins: MiddlewarePlugin[] = [];

        const clientRoot =
            process.env.NODE_ENV === "production"
                ? join(root, "dist", "client")
                : join(root, "src");

        if (process.env.NODE_ENV === "production") {
            logger.info(
                "Serving Vite build statically as we are in production mode"
            );

            const staticServer = serveStatic({
                root: clientRoot,
                gzip: config?.gzip,
                defaultFilename: ["index.html"],
                defaultExtension: ["html"]
            });

            plugins.push({
                type: "middleware",
                name: "vite-prod",
                shouldHandle,
                async handle(ctx, next) {
                    await staticServer(ctx, next);
                }
            });
        } else {
            logger.info(
                "Starting Vite dev server as we are not in production mode"
            );

            const {createServer} = await import("vite");
            const vds = await createServer({
                root: clientRoot,
                server: {middlewareMode: true}
            });

            logger.debug("Initialised Vite dev server");

            plugins.push({
                type: "middleware",
                name: "vite-dev",
                shouldHandle,
                async handle(ctx, next) {
                    const rExM = ctx.ctx[
                        runExpressMiddlewareSymbol
                        // eslint-disable-next-line
                    ] as any;
                    assert(rExM, "RExM is not set on request");
                    await rExM(vds.middlewares, next);
                }
            });
        }

        plugins.push(
            {
                type: "middleware",
                name: "vite-plugin-ssr",
                shouldHandle,
                async handle(ctx, next) {
                    const pageContextInit: Omit<
                        PageContext,
                        | "Page"
                        | "pageProps"
                        | "urlPathname"
                        | "helmetContext"
                        | "routeParams"
                        | "navigate"
                    > & {urlOriginal: string} = {
                        urlOriginal: ctx.req.url.pathname,
                        config: onlyKeys(config, [
                            "favicon",
                            "logo",
                            "logoText"
                        ]),
                        plugins: {
                            database: databasePlugin,
                            authentication: authenticationPlugin,
                            storage: storagePlugins,
                            validation: validationPlugin
                        },
                        clientPlugins: {
                            authentication:
                                getSerialisablePlugin(authenticationPlugin),
                            storage: Object.fromEntries(
                                Object.entries(storagePlugins).map(
                                    ([k, v]) =>
                                        [k, getSerialisablePlugin(v)] as const
                                )
                            ) as PageContext["clientPlugins"]["storage"],
                            validation: getSerialisablePlugin(validationPlugin)
                        },
                        httpRequest: ctx.req
                    };

                    const {httpResponse} = await renderPage(pageContextInit);

                    if (!httpResponse) {
                        await next();
                        return;
                    }

                    const {statusCode, contentType} = httpResponse;

                    ctx.res.headers.set("content-type", contentType);

                    const body = await ctx.res.flushHeaders(statusCode);
                    httpResponse.pipe(body.body);
                }
            },
            createRouteMiddlewarePlugin("GET /favicon.ico", async ctx => {
                const url = fillUrl<AssetUrlParams>(
                    storagePlugins.static.assetUrl,
                    {
                        id: config.favicon.default,
                        category: "static"
                    }
                );

                ctx.res.headers.set("location", url);
                await ctx.res.flushHeaders(308);
            })
        );

        return plugins;
    }
};

export default pluginExport;
