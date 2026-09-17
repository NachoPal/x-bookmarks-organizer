import { registerProvider } from '../registry';
import { claudeCliProvider } from './claude-cli';

/**
 * The one file a new provider adds a line to.
 *
 * Importing this module registers every built-in provider; `./factory` does it
 * for you, so nothing else in the app needs to know the list.
 */
registerProvider(claudeCliProvider);

export { claudeCliProvider };
