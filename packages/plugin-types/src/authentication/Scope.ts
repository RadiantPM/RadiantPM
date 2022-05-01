interface PageViewScope<Page extends string> {
    kind: "page.view";
    page: Page;
}

type HomepageViewScope = PageViewScope<"homepage">;

interface FeedViewScope {
    kind: "feed.view";
    slug: string;
}

interface FeedCreateScope {
    kind: "feed.create";
    slug: string;
}

interface PackageViewScope {
    kind: "package.view";
    feedSlug: string;
    slug: string;
}

interface PackageCreateScope {
    kind: "package.create";
    feedSlug: string;
    slug: string;
}

type Scopes =
    | HomepageViewScope
    | FeedViewScope
    | FeedCreateScope
    | PackageViewScope
    | PackageCreateScope;

type Scope<Filter extends Scopes["kind"] = Scopes["kind"]> = Extract<
    Scopes,
    {kind: Filter}
>;

export default Scope;

const validScopeKinds: ReadonlySet<Scope["kind"]> = new Set<Scope["kind"]>([
    "page.view",
    "feed.view",
    "feed.create",
    "package.view",
    "package.create"
]);

export function isValidScopeKind(kind: string): kind is Scope["kind"] {
    return validScopeKinds.has(kind as Scope["kind"]);
}
