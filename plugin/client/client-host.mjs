// The native DSH Loader discovers the browser export from this package row.
export const inject = ['workspaceRegistry'];

export async function apply(ctx) {
  // DSH canonicalizes the existing directory and reuses an existing record.
  // Its registry owns storage and preserves any user-chosen title/order.
  // Do not undo this durable registration when the presentation plugin stops.
  await ctx.workspaceRegistry.create(process.cwd());
}
