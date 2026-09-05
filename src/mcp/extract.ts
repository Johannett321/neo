/**
 * Prints the tool list the connector is built with.
 *
 * The MCP server has to advertise Neo's tools before it has spoken to Neo — Claude
 * Desktop starts it when Claude Desktop opens, which is rarely when the app is
 * already running. Baking the list in is what makes the tools present anyway, and
 * generating it here from `TOOLS` itself is what stops the baked copy from becoming
 * a second, drifting description of them.
 *
 * Run with `electron` aliased to the test stub, exactly as `verify` is: importing
 * the tools does not open a database, it only reads what they say about themselves.
 */
import { describeTools } from '../main/lib/mcp/bridge'

process.stdout.write(JSON.stringify(describeTools(), null, 2))
