/**
 * @license
 * Copyright 2013 Google Inc. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


/**
 * @fileoverview Methods for parsing ASCII Armor and Radix-64.
 * @author adhintz@google.com (Drew Hintz)
 */

goog.provide('e2e.openpgp.asciiArmor');

goog.require('e2e');
goog.require('e2e.openpgp.ClearSignMessage');
goog.require('e2e.openpgp.error.ParseError');
goog.require('e2e.openpgp.error.SerializationError');
goog.require('goog.array');
goog.require('goog.crypt');
goog.require('goog.crypt.base64');
goog.require('goog.string');


/**
 * Does base64 decoding ignoring extra characters, such as whitespace.
 * @param {string} ascii The ASCII text to parse.
 * @return {!e2e.ByteArray} The decoded data.
 * @private
 */
e2e.openpgp.asciiArmor.decodeRadix64_ = function(ascii) {
  var real = ascii.replace(/[^a-zA-Z0-9+/=]+/g, '');
  return /** @type {!e2e.ByteArray} */ (
      goog.crypt.base64.decodeStringToByteArray(real));
};


/**
 * Does base64 encoding, inserting newlines to wrap long text.
 * @param {!e2e.ByteArray} data The data to encode.
 * @return {string} The encoded data as ASCII text.
 * @private
 */
e2e.openpgp.asciiArmor.encodeRadix64_ = function(data) {
  var ascii = goog.crypt.base64.encodeByteArray(data);
  var lines = ascii.replace(/.{1,64}/g, '$&\r\n');
  return lines.slice(0, -2);  // Remove extra \r\n at end.
};


/**
 * Calculates CRC24.
 * @param {!e2e.ByteArray} data The data to do a checksum of.
 * @return {number} The checksum.
 * @private
 */
e2e.openpgp.asciiArmor.crc24_ = function(data) {
  var CRC24_INIT = 0xB704CE;
  var CRC24_POLY = 0x1864CFB;
  var j = 0;
  var crc = CRC24_INIT;
  while (j < data.length) {
    crc ^= data[j++] << 16;
    for (var i = 0; i < 8; i++) {
      crc = crc << 1;
      if (crc & 0x1000000)
        crc ^= CRC24_POLY;
    }
  }
  return crc & 0xFFFFFF;
};


/**
 * The regular expression to accept as a new line. It's more lenient to
 * support invalid encodings generated by some clients.
 * @const {string}
 * @private
 */
e2e.openpgp.asciiArmor.NEW_LINE_ = '[\\t\\u00a0 ]?\\r?\\n';


/**
 * Parses the first ASCII Armor in a string.
 * Specified in RFC 4880 Section 6.2.
 * Throws a {@code e2e.openpgp.error.ParseError} if the Armor is invalid.
 * @param {string} text The text to parse as ASCII Armor.
 * @return {!e2e.openpgp.ArmoredMessage} The parsed message.
 */
e2e.openpgp.asciiArmor.parse = function(text) {
  var armors = e2e.openpgp.asciiArmor.parseAll(text, 1);
  if (armors.length !== 1) {
    throw new e2e.openpgp.error.ParseError('ASCII Armor not found.');
  }
  return armors[0];
};


/**
 * Parses all ASCII Armors present in a string.
 * Specified in RFC 4880 Section 6.2.
 * Throws a {@code e2e.openpgp.error.ParseError} if the Armor is invalid.
 * @param {string} text The text to parse as ASCII Armor.
 * @param {number=} opt_limit Stop parsing once opt_limit armors have been
 *     parsed.
 * @return {!Array.<!e2e.openpgp.ArmoredMessage>} The parsed message.
 */
e2e.openpgp.asciiArmor.parseAll = function(text, opt_limit) {
  // The 0x80 bit is always set for the Packet Tag for OpenPGP packets.
  if (text.charCodeAt(0) >= 0x80) {
    // Not ASCII Armored. Treat as a binary OpenPGP block
    return [{
      'data': goog.crypt.stringToByteArray(text),
      'type': 'BINARY',
      'startOffset': 0,
      'endOffset': text.length
    }];
  }
  if (text.indexOf('-----BEGIN PGP ') == -1) {
    return [];
  }

  var armor, newLine = e2e.openpgp.asciiArmor.NEW_LINE_;
  // TODO(adhintz) Switch away from regex to line-by-line parsing.
  var armorRe = new RegExp(
      '(^|' + newLine + ')-----BEGIN PGP ([^-]+)-----' + newLine +
      '((?:[A-Za-z]+:[ ][^\\n]+' + newLine + ')*)' + newLine + // headers
      '((?:[a-zA-Z0-9/+]+=*' + newLine + ')*)' + // body
      '(?:=([a-zA-Z0-9/+]+))?' + newLine + // checksum
      '(?:' + newLine + ')*-----END PGP \\2-----($|' + newLine + ')', 'gm');
  var validArmors = [], payload, checksum, calculatedChecksum, prefixNewline,
      suffixNewline, charset, charsetMatch;
  while ((!goog.isDef(opt_limit) || opt_limit > 0) &&
         goog.isDefAndNotNull(armor = armorRe.exec(text))) {
    prefixNewline = armor[1];
    suffixNewline = armor[6];
    payload = e2e.openpgp.asciiArmor.decodeRadix64_(armor[4]);
    checksum = e2e.openpgp.asciiArmor.decodeRadix64_(armor[5]);
    calculatedChecksum = [e2e.openpgp.asciiArmor.crc24_(payload)];
    calculatedChecksum = e2e.dwordArrayToByteArray(calculatedChecksum);
    calculatedChecksum = calculatedChecksum.slice(-3);
    if (calculatedChecksum.join('') != checksum.join('')) {
      throw new e2e.openpgp.error.ParseError(
          'ASCII Armor checksum incorrect.');
    }
    charsetMatch = armor[3].match(/^Charset: ([^\r\n]+)\r?\n/im);
    if (charsetMatch) {
      charset = charsetMatch[1].toLowerCase().match(/[\w-]+/)[0] || 'utf-8';
    } else {
      charset = undefined;
    }
    validArmors.push({
      'data': payload,
      'charset': charset,
      'type': armor[2],
      'startOffset': armor.index + prefixNewline.length,
      'endOffset': armorRe.lastIndex - suffixNewline.length});
    if (goog.isDef(opt_limit)) {
      opt_limit--;
    }
  }
  return validArmors;
};


/**
 * Parses ASCII Armor ClearSign messages.
 * Specified in RFC 4880 Section 6.2.
 * Throws a {@code e2e.openpgp.error.ParseError} if the Armor is invalid.
 * @param {string} text The text to parse as ASCII Armor.
 * @return {!e2e.openpgp.ClearSignMessage} Parsed message parameters
 *   and the signature ByteArray.
 */
e2e.openpgp.asciiArmor.parseClearSign = function(text) {
  var startMessage = text.indexOf('-----BEGIN PGP SIGNED MESSAGE-----');
  var startSignature = text.indexOf('-----BEGIN PGP SIGNATURE-----');
  var armor = text.substr(startMessage, startSignature - startMessage).match(
      new RegExp('^-----BEGIN PGP SIGNED MESSAGE-----\\r?\\n' +
      'Hash:[ ]([^\\n\\r]+)\\r?\\n' + // Hash header
      '(?:[A-Za-z]+:[ ][^\\n\\r]+\\r?\\n)*' + // Other headers
      '\\r?\\n')); // New line
  if (!armor) {
    throw new e2e.openpgp.error.ParseError('invalid clearsign format');
  }
  var hashString = armor[1];
  var startBody = text.indexOf('\n\n') + 2;
  if (startBody == (-1 + 2)) {
    startBody = text.indexOf('\r\n\r\n') + 4;
  }
  var body = text.substr(startBody,
                         startSignature - startBody - 1);  // -1 to remove \n
  if (goog.string.endsWith(body, '\r')) {
    body = goog.string.removeAt(body, body.length - 1, 1);  // Remove ending \r
  }
  body = e2e.openpgp.asciiArmor.dashUnescape(body);
  body = e2e.openpgp.asciiArmor.convertNewlines(body);
  var signature = e2e.openpgp.asciiArmor.parse(text.substr(startSignature));
  return new e2e.openpgp.ClearSignMessage(body, signature.data, hashString);
};


/**
 * Canonicalizes data by converting all line endings to CR+LF and removing
 * trailing whitespace.
 * @param {string} data The text to canonicalize.
 * @return {string} The canonicalized text.
 */
e2e.openpgp.asciiArmor.convertNewlines = function(data) {
  return data.replace(/[\x20\x09]*(\r\n|\r|\n)/g, '\r\n');
};


/**
 * Checks if the message has a clearsign message format
 * @param  {string} text
 * @return {!boolean} true if the message has a clearsign message format.
 */
e2e.openpgp.asciiArmor.isClearSign = function(text) {
  var startMessage = text.indexOf('-----BEGIN PGP SIGNED MESSAGE-----');
  var startSignature = text.indexOf('-----BEGIN PGP SIGNATURE-----');
  return Boolean(startMessage !== -1 &&
      startSignature !== -1 &&
      startSignature > startMessage);
};


/**
 * Dash-Escapes Text as described in RFC4880 7.1.
 * @param {string} plaintext The plaintext that has already been through
 *     e2e.openpgp.asciiArmor.convertNewlines().
 * @protected
 * @return {string} The dash-escaped text.
 */
e2e.openpgp.asciiArmor.dashEscape = function(plaintext) {
  return (plaintext.replace(/^\-/gm, '\- -')  // Dash-escape leading -
      .replace(/^From /gm, '\- From ')  // Dash-escape leading "From "
      .replace(/[\t ]*$/gm, ''));  // Remove trailing tabs and spaces.
};


/**
 * Removes the Dash-Escaping as described in RFC4880 7.1.
 * @param {string} plaintext Text with optional dash-escapes
 * @protected
 * @return {string} The text with removed dash-escapes.
 */
e2e.openpgp.asciiArmor.dashUnescape = function(plaintext) {
  return (plaintext.replace(/^\- /gm, ''));
};


/**
 * Encode data as ASCII Armor, with a trailing new line characters (\r\n).
 * Specified in RFC 4880 Section 6.2.
 * @param {string} type Descriptive type, such as "MESSAGE".
 * @param {!e2e.ByteArray} payload The data to encode.
 * @param {!Object.<string>=} opt_headers Extra headers to add.
 * @return {string} The ASCII Armored text.
 */
e2e.openpgp.asciiArmor.encode = function(type, payload, opt_headers) {
  var byteChecksum = e2e.dwordArrayToByteArray(
      [e2e.openpgp.asciiArmor.crc24_(payload)]);
  var checksum = e2e.openpgp.asciiArmor.encodeRadix64_(
      byteChecksum.slice(-3));
  var headers = [];
  if (type !== 'SIGNATURE') {
    headers = ['Charset: UTF-8'];
  }
  if (opt_headers) {
    var headerNames = Object.getOwnPropertyNames(opt_headers);
    for (var i = 0; i < headerNames.length; i++) {
      var key = headerNames[i];
      var val = opt_headers[key];
      if (key.match(/^\w+$/) && val && val.match(/^[^\r\n]+$/)) {
        headers.push(key + ': ' + val);
      }
    }
  }
  return goog.array.flatten(
      '-----BEGIN PGP ' + type + '-----',
      headers,
      '',
      e2e.openpgp.asciiArmor.encodeRadix64_(payload),
      '=' + checksum,
      '-----END PGP ' + type + '-----',
      ''
  ).join('\r\n');
};


/**
 * ASCII armors the OpenPGP block - supports both regular OpenPGP blocks and
 * clearsign messages.
 * @param {!e2e.openpgp.block.Armorable} block The block to armor.
 * @param {!Object.<string>=} opt_headers Extra headers to add.
 * @return {string} The ASCII Armored text.
 */
e2e.openpgp.asciiArmor.armorBlock = function(block, opt_headers) {
  if (block.header == 'SIGNED MESSAGE') { // Clearsign - special type
    var body = block.getArmorBody();
    var sigs = block.getArmorSignatures();
    if (sigs.length !== 1) {
      throw new e2e.openpgp.error.SerializationError(
          'Clearsign messages need to have one and only one signature.');
    }
    var signature = sigs[0];
    return ['-----BEGIN PGP ' + block.header + '-----',
            'Hash: ' + signature.hashAlgorithm,
            '',
            e2e.openpgp.asciiArmor.dashEscape(
                e2e.openpgp.asciiArmor.convertNewlines(
                    e2e.byteArrayToString(body))),
            e2e.openpgp.asciiArmor.encode('SIGNATURE',
                signature.serialize(), opt_headers)
    ].join('\r\n');
  } else {
    return e2e.openpgp.asciiArmor.encode(block.header,
        block.getArmorBody());
  }
};


/**
 * Extracts the PGP block from the free-text content. If no PGP block exists,
 * returns the original content. If multiple PGP blocks are present, only the
 * first one is returned.
 * @param {string} content The original content from which the PGP block is to
 *     be extracted.
 * @return {string} The first PGP block that is found in the original content.
 */
e2e.openpgp.asciiArmor.extractPgpBlock = function(content) {
  var extractRe =
      /(.*)-----BEGIN\sPGP\s([\w\s]+)-----[\s\S.]*(?:MESSAGE|BLOCK|SIGNATURE)-----/;
  var result = extractRe.exec(content);
  if (result) {
    var pgpBlock = result[0];
    var linePrefix = result[1];
    var firstPrefixType = result[2];
    var expectedSuffixType = firstPrefixType;
    if (firstPrefixType == 'SIGNED MESSAGE') {
      expectedSuffixType = 'SIGNATURE';
    }
    // Check if more then one blocks are present.
    if (/-----BEGIN\sPGP/.test(pgpBlock.substring(1))) {
      // Cutoff at first Armor Suffix
      pgpBlock = pgpBlock.replace(new RegExp(
          '(-----END\\sPGP\\s' + expectedSuffixType + '-----)([\\s\\S.]*)$',
          'g'),
          '$1');
    }
    if (linePrefix.length > 0) {
      // Make trailing spaces optional in the line prefix.
      // They get removed for otherwise empty lines.
      pgpBlock = pgpBlock.replace(new RegExp(
          '^' + goog.string.regExpEscape(goog.string.trimRight(linePrefix)) +
              '[\\t ]*',
          'gm'),
          '');
    }
    return pgpBlock;
  } else {
    return content;
  }
};


/**
 * Marks an ASCII Armor as a draft message.
 * @param {string} armoredContent The ASCII Armor to mark as draft.
 * @return {string} The marked ASCII Armor.
 */
e2e.openpgp.asciiArmor.markAsDraft = function(armoredContent) {
  var lines = armoredContent.split('\n');
  goog.array.insertAt(lines, 'isDraft: true', 1);
  return lines.join('\n');
};


/**
 * Indicates if the ASCII Armor has been marked as draft.
 * @param {string} armoredContent The ASCII Armor to check.
 * @return {boolean} True if the ASCII Armor is marked as draft.
 *     Otherwise false.
 */
e2e.openpgp.asciiArmor.isDraft = function(armoredContent) {
  return armoredContent.indexOf('\nisDraft: true\n') > -1;
};
