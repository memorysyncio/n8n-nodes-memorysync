// The version the nodes announce on the wire (User-Agent). It is read from
// package.json — tsc copies that file into dist/ (it is listed in tsconfig
// "include"), so the header can never lag the published version: 1.0.4
// shipped still announcing itself as 1.0.3 because the string was typed by
// hand.
import { name, version } from '../../package.json';

export const PACKAGE_NAME: string = name;
export const PACKAGE_VERSION: string = version;
export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;
