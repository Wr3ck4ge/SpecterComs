/*eslint-disable block-scoped-var, id-length, no-control-regex, no-magic-numbers, no-prototype-builtins, no-redeclare, no-shadow, no-var, sort-vars*/
"use strict";

var $protobuf = require("protobufjs/minimal");

// Common aliases
var $Reader = $protobuf.Reader, $Writer = $protobuf.Writer, $util = $protobuf.util;

// Exported root namespace
var $root = $protobuf.roots["default"] || ($protobuf.roots["default"] = {});

$root.specter = (function() {

    /**
     * Namespace specter.
     * @exports specter
     * @namespace
     */
    var specter = {};

    specter.v1 = (function() {

        /**
         * Namespace v1.
         * @memberof specter
         * @namespace
         */
        var v1 = {};

        /**
         * CommsTier enum.
         * @name specter.v1.CommsTier
         * @enum {number}
         * @property {number} TIER_UNSPECIFIED=0 TIER_UNSPECIFIED value
         * @property {number} TIER_COMMANDER=1 TIER_COMMANDER value
         * @property {number} TIER_OFFICER=2 TIER_OFFICER value
         * @property {number} TIER_OPERATIVE=3 TIER_OPERATIVE value
         */
        v1.CommsTier = (function() {
            var valuesById = {}, values = Object.create(valuesById);
            values[valuesById[0] = "TIER_UNSPECIFIED"] = 0;
            values[valuesById[1] = "TIER_COMMANDER"] = 1;
            values[valuesById[2] = "TIER_OFFICER"] = 2;
            values[valuesById[3] = "TIER_OPERATIVE"] = 3;
            return values;
        })();

        /**
         * PriorityLevel enum.
         * @name specter.v1.PriorityLevel
         * @enum {number}
         * @property {number} PRIORITY_UNSPECIFIED=0 PRIORITY_UNSPECIFIED value
         * @property {number} PRIORITY_GLOBAL_ADMIN=1 PRIORITY_GLOBAL_ADMIN value
         * @property {number} PRIORITY_GROUP_LEADER=2 PRIORITY_GROUP_LEADER value
         * @property {number} PRIORITY_MEMBER=3 PRIORITY_MEMBER value
         * @property {number} PRIORITY_LISTENER=4 PRIORITY_LISTENER value
         */
        v1.PriorityLevel = (function() {
            var valuesById = {}, values = Object.create(valuesById);
            values[valuesById[0] = "PRIORITY_UNSPECIFIED"] = 0;
            values[valuesById[1] = "PRIORITY_GLOBAL_ADMIN"] = 1;
            values[valuesById[2] = "PRIORITY_GROUP_LEADER"] = 2;
            values[valuesById[3] = "PRIORITY_MEMBER"] = 3;
            values[valuesById[4] = "PRIORITY_LISTENER"] = 4;
            return values;
        })();

        v1.ShipSession = (function() {

            /**
             * Properties of a ShipSession.
             * @memberof specter.v1
             * @interface IShipSession
             * @property {string|null} [shipId] ShipSession shipId
             * @property {string|null} [fleetId] ShipSession fleetId
             * @property {specter.v1.CommsTier|null} [userTier] ShipSession userTier
             */

            /**
             * Constructs a new ShipSession.
             * @memberof specter.v1
             * @classdesc Represents a ShipSession.
             * @implements IShipSession
             * @constructor
             * @param {specter.v1.IShipSession=} [properties] Properties to set
             */
            function ShipSession(properties) {
                if (properties)
                    for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null)
                            this[keys[i]] = properties[keys[i]];
            }

            /**
             * ShipSession shipId.
             * @member {string} shipId
             * @memberof specter.v1.ShipSession
             * @instance
             */
            ShipSession.prototype.shipId = "";

            /**
             * ShipSession fleetId.
             * @member {string} fleetId
             * @memberof specter.v1.ShipSession
             * @instance
             */
            ShipSession.prototype.fleetId = "";

            /**
             * ShipSession userTier.
             * @member {specter.v1.CommsTier} userTier
             * @memberof specter.v1.ShipSession
             * @instance
             */
            ShipSession.prototype.userTier = 0;

            /**
             * Creates a new ShipSession instance using the specified properties.
             * @function create
             * @memberof specter.v1.ShipSession
             * @static
             * @param {specter.v1.IShipSession=} [properties] Properties to set
             * @returns {specter.v1.ShipSession} ShipSession instance
             */
            ShipSession.create = function create(properties) {
                return new ShipSession(properties);
            };

            /**
             * Encodes the specified ShipSession message. Does not implicitly {@link specter.v1.ShipSession.verify|verify} messages.
             * @function encode
             * @memberof specter.v1.ShipSession
             * @static
             * @param {specter.v1.IShipSession} message ShipSession message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ShipSession.encode = function encode(message, writer) {
                if (!writer)
                    writer = $Writer.create();
                if (message.shipId != null && Object.hasOwnProperty.call(message, "shipId"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.shipId);
                if (message.fleetId != null && Object.hasOwnProperty.call(message, "fleetId"))
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.fleetId);
                if (message.userTier != null && Object.hasOwnProperty.call(message, "userTier"))
                    writer.uint32(/* id 3, wireType 0 =*/24).int32(message.userTier);
                return writer;
            };

            /**
             * Encodes the specified ShipSession message, length delimited. Does not implicitly {@link specter.v1.ShipSession.verify|verify} messages.
             * @function encodeDelimited
             * @memberof specter.v1.ShipSession
             * @static
             * @param {specter.v1.IShipSession} message ShipSession message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ShipSession.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a ShipSession message from the specified reader or buffer.
             * @function decode
             * @memberof specter.v1.ShipSession
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {specter.v1.ShipSession} ShipSession
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            ShipSession.decode = function decode(reader, length, error) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.specter.v1.ShipSession();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.shipId = reader.string();
                            break;
                        }
                    case 2: {
                            message.fleetId = reader.string();
                            break;
                        }
                    case 3: {
                            message.userTier = reader.int32();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a ShipSession message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof specter.v1.ShipSession
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {specter.v1.ShipSession} ShipSession
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            ShipSession.decodeDelimited = function decodeDelimited(reader) {
                if (!(reader instanceof $Reader))
                    reader = new $Reader(reader);
                return this.decode(reader, reader.uint32());
            };

            /**
             * Verifies a ShipSession message.
             * @function verify
             * @memberof specter.v1.ShipSession
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            ShipSession.verify = function verify(message) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (message.shipId != null && message.hasOwnProperty("shipId"))
                    if (!$util.isString(message.shipId))
                        return "shipId: string expected";
                if (message.fleetId != null && message.hasOwnProperty("fleetId"))
                    if (!$util.isString(message.fleetId))
                        return "fleetId: string expected";
                if (message.userTier != null && message.hasOwnProperty("userTier"))
                    switch (message.userTier) {
                    default:
                        return "userTier: enum value expected";
                    case 0:
                    case 1:
                    case 2:
                    case 3:
                        break;
                    }
                return null;
            };

            /**
             * Creates a ShipSession message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof specter.v1.ShipSession
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {specter.v1.ShipSession} ShipSession
             */
            ShipSession.fromObject = function fromObject(object) {
                if (object instanceof $root.specter.v1.ShipSession)
                    return object;
                var message = new $root.specter.v1.ShipSession();
                if (object.shipId != null)
                    message.shipId = String(object.shipId);
                if (object.fleetId != null)
                    message.fleetId = String(object.fleetId);
                switch (object.userTier) {
                default:
                    if (typeof object.userTier === "number") {
                        message.userTier = object.userTier;
                        break;
                    }
                    break;
                case "TIER_UNSPECIFIED":
                case 0:
                    message.userTier = 0;
                    break;
                case "TIER_COMMANDER":
                case 1:
                    message.userTier = 1;
                    break;
                case "TIER_OFFICER":
                case 2:
                    message.userTier = 2;
                    break;
                case "TIER_OPERATIVE":
                case 3:
                    message.userTier = 3;
                    break;
                }
                return message;
            };

            /**
             * Creates a plain object from a ShipSession message. Also converts values to other types if specified.
             * @function toObject
             * @memberof specter.v1.ShipSession
             * @static
             * @param {specter.v1.ShipSession} message ShipSession
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            ShipSession.toObject = function toObject(message, options) {
                if (!options)
                    options = {};
                var object = {};
                if (options.defaults) {
                    object.shipId = "";
                    object.fleetId = "";
                    object.userTier = options.enums === String ? "TIER_UNSPECIFIED" : 0;
                }
                if (message.shipId != null && message.hasOwnProperty("shipId"))
                    object.shipId = message.shipId;
                if (message.fleetId != null && message.hasOwnProperty("fleetId"))
                    object.fleetId = message.fleetId;
                if (message.userTier != null && message.hasOwnProperty("userTier"))
                    object.userTier = options.enums === String ? $root.specter.v1.CommsTier[message.userTier] === undefined ? message.userTier : $root.specter.v1.CommsTier[message.userTier] : message.userTier;
                return object;
            };

            /**
             * Converts this ShipSession to JSON.
             * @function toJSON
             * @memberof specter.v1.ShipSession
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            ShipSession.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for ShipSession
             * @function getTypeUrl
             * @memberof specter.v1.ShipSession
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            ShipSession.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/specter.v1.ShipSession";
            };

            return ShipSession;
        })();

        v1.MissionEvent = (function() {

            /**
             * Properties of a MissionEvent.
             * @memberof specter.v1
             * @interface IMissionEvent
             * @property {string|null} [eventId] MissionEvent eventId
             * @property {number|Long|null} [startTime] MissionEvent startTime
             * @property {number|Long|null} [endTime] MissionEvent endTime
             */

            /**
             * Constructs a new MissionEvent.
             * @memberof specter.v1
             * @classdesc Represents a MissionEvent.
             * @implements IMissionEvent
             * @constructor
             * @param {specter.v1.IMissionEvent=} [properties] Properties to set
             */
            function MissionEvent(properties) {
                if (properties)
                    for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null)
                            this[keys[i]] = properties[keys[i]];
            }

            /**
             * MissionEvent eventId.
             * @member {string} eventId
             * @memberof specter.v1.MissionEvent
             * @instance
             */
            MissionEvent.prototype.eventId = "";

            /**
             * MissionEvent startTime.
             * @member {number|Long} startTime
             * @memberof specter.v1.MissionEvent
             * @instance
             */
            MissionEvent.prototype.startTime = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

            /**
             * MissionEvent endTime.
             * @member {number|Long} endTime
             * @memberof specter.v1.MissionEvent
             * @instance
             */
            MissionEvent.prototype.endTime = $util.Long ? $util.Long.fromBits(0,0,false) : 0;

            /**
             * Creates a new MissionEvent instance using the specified properties.
             * @function create
             * @memberof specter.v1.MissionEvent
             * @static
             * @param {specter.v1.IMissionEvent=} [properties] Properties to set
             * @returns {specter.v1.MissionEvent} MissionEvent instance
             */
            MissionEvent.create = function create(properties) {
                return new MissionEvent(properties);
            };

            /**
             * Encodes the specified MissionEvent message. Does not implicitly {@link specter.v1.MissionEvent.verify|verify} messages.
             * @function encode
             * @memberof specter.v1.MissionEvent
             * @static
             * @param {specter.v1.IMissionEvent} message MissionEvent message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            MissionEvent.encode = function encode(message, writer) {
                if (!writer)
                    writer = $Writer.create();
                if (message.eventId != null && Object.hasOwnProperty.call(message, "eventId"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.eventId);
                if (message.startTime != null && Object.hasOwnProperty.call(message, "startTime"))
                    writer.uint32(/* id 2, wireType 0 =*/16).int64(message.startTime);
                if (message.endTime != null && Object.hasOwnProperty.call(message, "endTime"))
                    writer.uint32(/* id 3, wireType 0 =*/24).int64(message.endTime);
                return writer;
            };

            /**
             * Encodes the specified MissionEvent message, length delimited. Does not implicitly {@link specter.v1.MissionEvent.verify|verify} messages.
             * @function encodeDelimited
             * @memberof specter.v1.MissionEvent
             * @static
             * @param {specter.v1.IMissionEvent} message MissionEvent message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            MissionEvent.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a MissionEvent message from the specified reader or buffer.
             * @function decode
             * @memberof specter.v1.MissionEvent
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {specter.v1.MissionEvent} MissionEvent
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            MissionEvent.decode = function decode(reader, length, error) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.specter.v1.MissionEvent();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.eventId = reader.string();
                            break;
                        }
                    case 2: {
                            message.startTime = reader.int64();
                            break;
                        }
                    case 3: {
                            message.endTime = reader.int64();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a MissionEvent message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof specter.v1.MissionEvent
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {specter.v1.MissionEvent} MissionEvent
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            MissionEvent.decodeDelimited = function decodeDelimited(reader) {
                if (!(reader instanceof $Reader))
                    reader = new $Reader(reader);
                return this.decode(reader, reader.uint32());
            };

            /**
             * Verifies a MissionEvent message.
             * @function verify
             * @memberof specter.v1.MissionEvent
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            MissionEvent.verify = function verify(message) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (message.eventId != null && message.hasOwnProperty("eventId"))
                    if (!$util.isString(message.eventId))
                        return "eventId: string expected";
                if (message.startTime != null && message.hasOwnProperty("startTime"))
                    if (!$util.isInteger(message.startTime) && !(message.startTime && $util.isInteger(message.startTime.low) && $util.isInteger(message.startTime.high)))
                        return "startTime: integer|Long expected";
                if (message.endTime != null && message.hasOwnProperty("endTime"))
                    if (!$util.isInteger(message.endTime) && !(message.endTime && $util.isInteger(message.endTime.low) && $util.isInteger(message.endTime.high)))
                        return "endTime: integer|Long expected";
                return null;
            };

            /**
             * Creates a MissionEvent message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof specter.v1.MissionEvent
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {specter.v1.MissionEvent} MissionEvent
             */
            MissionEvent.fromObject = function fromObject(object) {
                if (object instanceof $root.specter.v1.MissionEvent)
                    return object;
                var message = new $root.specter.v1.MissionEvent();
                if (object.eventId != null)
                    message.eventId = String(object.eventId);
                if (object.startTime != null)
                    if ($util.Long)
                        (message.startTime = $util.Long.fromValue(object.startTime)).unsigned = false;
                    else if (typeof object.startTime === "string")
                        message.startTime = parseInt(object.startTime, 10);
                    else if (typeof object.startTime === "number")
                        message.startTime = object.startTime;
                    else if (typeof object.startTime === "object")
                        message.startTime = new $util.LongBits(object.startTime.low >>> 0, object.startTime.high >>> 0).toNumber();
                if (object.endTime != null)
                    if ($util.Long)
                        (message.endTime = $util.Long.fromValue(object.endTime)).unsigned = false;
                    else if (typeof object.endTime === "string")
                        message.endTime = parseInt(object.endTime, 10);
                    else if (typeof object.endTime === "number")
                        message.endTime = object.endTime;
                    else if (typeof object.endTime === "object")
                        message.endTime = new $util.LongBits(object.endTime.low >>> 0, object.endTime.high >>> 0).toNumber();
                return message;
            };

            /**
             * Creates a plain object from a MissionEvent message. Also converts values to other types if specified.
             * @function toObject
             * @memberof specter.v1.MissionEvent
             * @static
             * @param {specter.v1.MissionEvent} message MissionEvent
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            MissionEvent.toObject = function toObject(message, options) {
                if (!options)
                    options = {};
                var object = {};
                if (options.defaults) {
                    object.eventId = "";
                    if ($util.Long) {
                        var long = new $util.Long(0, 0, false);
                        object.startTime = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                    } else
                        object.startTime = options.longs === String ? "0" : 0;
                    if ($util.Long) {
                        var long = new $util.Long(0, 0, false);
                        object.endTime = options.longs === String ? long.toString() : options.longs === Number ? long.toNumber() : long;
                    } else
                        object.endTime = options.longs === String ? "0" : 0;
                }
                if (message.eventId != null && message.hasOwnProperty("eventId"))
                    object.eventId = message.eventId;
                if (message.startTime != null && message.hasOwnProperty("startTime"))
                    if (typeof message.startTime === "number")
                        object.startTime = options.longs === String ? String(message.startTime) : message.startTime;
                    else
                        object.startTime = options.longs === String ? $util.Long.prototype.toString.call(message.startTime) : options.longs === Number ? new $util.LongBits(message.startTime.low >>> 0, message.startTime.high >>> 0).toNumber() : message.startTime;
                if (message.endTime != null && message.hasOwnProperty("endTime"))
                    if (typeof message.endTime === "number")
                        object.endTime = options.longs === String ? String(message.endTime) : message.endTime;
                    else
                        object.endTime = options.longs === String ? $util.Long.prototype.toString.call(message.endTime) : options.longs === Number ? new $util.LongBits(message.endTime.low >>> 0, message.endTime.high >>> 0).toNumber() : message.endTime;
                return object;
            };

            /**
             * Converts this MissionEvent to JSON.
             * @function toJSON
             * @memberof specter.v1.MissionEvent
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            MissionEvent.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for MissionEvent
             * @function getTypeUrl
             * @memberof specter.v1.MissionEvent
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            MissionEvent.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/specter.v1.MissionEvent";
            };

            return MissionEvent;
        })();

        v1.UserSession = (function() {

            /**
             * Properties of a UserSession.
             * @memberof specter.v1
             * @interface IUserSession
             * @property {string|null} [userId] UserSession userId
             * @property {string|null} [sessionId] UserSession sessionId
             * @property {specter.v1.PriorityLevel|null} [priority] UserSession priority
             * @property {string|null} [currentChannelId] UserSession currentChannelId
             * @property {boolean|null} [isMuted] UserSession isMuted
             * @property {boolean|null} [isDeafened] UserSession isDeafened
             * @property {number|null} [ssrc] UserSession ssrc
             */

            /**
             * Constructs a new UserSession.
             * @memberof specter.v1
             * @classdesc Represents a UserSession.
             * @implements IUserSession
             * @constructor
             * @param {specter.v1.IUserSession=} [properties] Properties to set
             */
            function UserSession(properties) {
                if (properties)
                    for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null)
                            this[keys[i]] = properties[keys[i]];
            }

            /**
             * UserSession userId.
             * @member {string} userId
             * @memberof specter.v1.UserSession
             * @instance
             */
            UserSession.prototype.userId = "";

            /**
             * UserSession sessionId.
             * @member {string} sessionId
             * @memberof specter.v1.UserSession
             * @instance
             */
            UserSession.prototype.sessionId = "";

            /**
             * UserSession priority.
             * @member {specter.v1.PriorityLevel} priority
             * @memberof specter.v1.UserSession
             * @instance
             */
            UserSession.prototype.priority = 0;

            /**
             * UserSession currentChannelId.
             * @member {string} currentChannelId
             * @memberof specter.v1.UserSession
             * @instance
             */
            UserSession.prototype.currentChannelId = "";

            /**
             * UserSession isMuted.
             * @member {boolean} isMuted
             * @memberof specter.v1.UserSession
             * @instance
             */
            UserSession.prototype.isMuted = false;

            /**
             * UserSession isDeafened.
             * @member {boolean} isDeafened
             * @memberof specter.v1.UserSession
             * @instance
             */
            UserSession.prototype.isDeafened = false;

            /**
             * UserSession ssrc.
             * @member {number} ssrc
             * @memberof specter.v1.UserSession
             * @instance
             */
            UserSession.prototype.ssrc = 0;

            /**
             * Creates a new UserSession instance using the specified properties.
             * @function create
             * @memberof specter.v1.UserSession
             * @static
             * @param {specter.v1.IUserSession=} [properties] Properties to set
             * @returns {specter.v1.UserSession} UserSession instance
             */
            UserSession.create = function create(properties) {
                return new UserSession(properties);
            };

            /**
             * Encodes the specified UserSession message. Does not implicitly {@link specter.v1.UserSession.verify|verify} messages.
             * @function encode
             * @memberof specter.v1.UserSession
             * @static
             * @param {specter.v1.IUserSession} message UserSession message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            UserSession.encode = function encode(message, writer) {
                if (!writer)
                    writer = $Writer.create();
                if (message.userId != null && Object.hasOwnProperty.call(message, "userId"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.userId);
                if (message.sessionId != null && Object.hasOwnProperty.call(message, "sessionId"))
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.sessionId);
                if (message.priority != null && Object.hasOwnProperty.call(message, "priority"))
                    writer.uint32(/* id 3, wireType 0 =*/24).int32(message.priority);
                if (message.currentChannelId != null && Object.hasOwnProperty.call(message, "currentChannelId"))
                    writer.uint32(/* id 4, wireType 2 =*/34).string(message.currentChannelId);
                if (message.isMuted != null && Object.hasOwnProperty.call(message, "isMuted"))
                    writer.uint32(/* id 5, wireType 0 =*/40).bool(message.isMuted);
                if (message.isDeafened != null && Object.hasOwnProperty.call(message, "isDeafened"))
                    writer.uint32(/* id 6, wireType 0 =*/48).bool(message.isDeafened);
                if (message.ssrc != null && Object.hasOwnProperty.call(message, "ssrc"))
                    writer.uint32(/* id 7, wireType 0 =*/56).int32(message.ssrc);
                return writer;
            };

            /**
             * Encodes the specified UserSession message, length delimited. Does not implicitly {@link specter.v1.UserSession.verify|verify} messages.
             * @function encodeDelimited
             * @memberof specter.v1.UserSession
             * @static
             * @param {specter.v1.IUserSession} message UserSession message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            UserSession.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a UserSession message from the specified reader or buffer.
             * @function decode
             * @memberof specter.v1.UserSession
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {specter.v1.UserSession} UserSession
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            UserSession.decode = function decode(reader, length, error) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.specter.v1.UserSession();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.userId = reader.string();
                            break;
                        }
                    case 2: {
                            message.sessionId = reader.string();
                            break;
                        }
                    case 3: {
                            message.priority = reader.int32();
                            break;
                        }
                    case 4: {
                            message.currentChannelId = reader.string();
                            break;
                        }
                    case 5: {
                            message.isMuted = reader.bool();
                            break;
                        }
                    case 6: {
                            message.isDeafened = reader.bool();
                            break;
                        }
                    case 7: {
                            message.ssrc = reader.int32();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a UserSession message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof specter.v1.UserSession
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {specter.v1.UserSession} UserSession
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            UserSession.decodeDelimited = function decodeDelimited(reader) {
                if (!(reader instanceof $Reader))
                    reader = new $Reader(reader);
                return this.decode(reader, reader.uint32());
            };

            /**
             * Verifies a UserSession message.
             * @function verify
             * @memberof specter.v1.UserSession
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            UserSession.verify = function verify(message) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (message.userId != null && message.hasOwnProperty("userId"))
                    if (!$util.isString(message.userId))
                        return "userId: string expected";
                if (message.sessionId != null && message.hasOwnProperty("sessionId"))
                    if (!$util.isString(message.sessionId))
                        return "sessionId: string expected";
                if (message.priority != null && message.hasOwnProperty("priority"))
                    switch (message.priority) {
                    default:
                        return "priority: enum value expected";
                    case 0:
                    case 1:
                    case 2:
                    case 3:
                    case 4:
                        break;
                    }
                if (message.currentChannelId != null && message.hasOwnProperty("currentChannelId"))
                    if (!$util.isString(message.currentChannelId))
                        return "currentChannelId: string expected";
                if (message.isMuted != null && message.hasOwnProperty("isMuted"))
                    if (typeof message.isMuted !== "boolean")
                        return "isMuted: boolean expected";
                if (message.isDeafened != null && message.hasOwnProperty("isDeafened"))
                    if (typeof message.isDeafened !== "boolean")
                        return "isDeafened: boolean expected";
                if (message.ssrc != null && message.hasOwnProperty("ssrc"))
                    if (!$util.isInteger(message.ssrc))
                        return "ssrc: integer expected";
                return null;
            };

            /**
             * Creates a UserSession message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof specter.v1.UserSession
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {specter.v1.UserSession} UserSession
             */
            UserSession.fromObject = function fromObject(object) {
                if (object instanceof $root.specter.v1.UserSession)
                    return object;
                var message = new $root.specter.v1.UserSession();
                if (object.userId != null)
                    message.userId = String(object.userId);
                if (object.sessionId != null)
                    message.sessionId = String(object.sessionId);
                switch (object.priority) {
                default:
                    if (typeof object.priority === "number") {
                        message.priority = object.priority;
                        break;
                    }
                    break;
                case "PRIORITY_UNSPECIFIED":
                case 0:
                    message.priority = 0;
                    break;
                case "PRIORITY_GLOBAL_ADMIN":
                case 1:
                    message.priority = 1;
                    break;
                case "PRIORITY_GROUP_LEADER":
                case 2:
                    message.priority = 2;
                    break;
                case "PRIORITY_MEMBER":
                case 3:
                    message.priority = 3;
                    break;
                case "PRIORITY_LISTENER":
                case 4:
                    message.priority = 4;
                    break;
                }
                if (object.currentChannelId != null)
                    message.currentChannelId = String(object.currentChannelId);
                if (object.isMuted != null)
                    message.isMuted = Boolean(object.isMuted);
                if (object.isDeafened != null)
                    message.isDeafened = Boolean(object.isDeafened);
                if (object.ssrc != null)
                    message.ssrc = object.ssrc | 0;
                return message;
            };

            /**
             * Creates a plain object from a UserSession message. Also converts values to other types if specified.
             * @function toObject
             * @memberof specter.v1.UserSession
             * @static
             * @param {specter.v1.UserSession} message UserSession
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            UserSession.toObject = function toObject(message, options) {
                if (!options)
                    options = {};
                var object = {};
                if (options.defaults) {
                    object.userId = "";
                    object.sessionId = "";
                    object.priority = options.enums === String ? "PRIORITY_UNSPECIFIED" : 0;
                    object.currentChannelId = "";
                    object.isMuted = false;
                    object.isDeafened = false;
                    object.ssrc = 0;
                }
                if (message.userId != null && message.hasOwnProperty("userId"))
                    object.userId = message.userId;
                if (message.sessionId != null && message.hasOwnProperty("sessionId"))
                    object.sessionId = message.sessionId;
                if (message.priority != null && message.hasOwnProperty("priority"))
                    object.priority = options.enums === String ? $root.specter.v1.PriorityLevel[message.priority] === undefined ? message.priority : $root.specter.v1.PriorityLevel[message.priority] : message.priority;
                if (message.currentChannelId != null && message.hasOwnProperty("currentChannelId"))
                    object.currentChannelId = message.currentChannelId;
                if (message.isMuted != null && message.hasOwnProperty("isMuted"))
                    object.isMuted = message.isMuted;
                if (message.isDeafened != null && message.hasOwnProperty("isDeafened"))
                    object.isDeafened = message.isDeafened;
                if (message.ssrc != null && message.hasOwnProperty("ssrc"))
                    object.ssrc = message.ssrc;
                return object;
            };

            /**
             * Converts this UserSession to JSON.
             * @function toJSON
             * @memberof specter.v1.UserSession
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            UserSession.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for UserSession
             * @function getTypeUrl
             * @memberof specter.v1.UserSession
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            UserSession.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/specter.v1.UserSession";
            };

            return UserSession;
        })();

        v1.ChannelRoster = (function() {

            /**
             * Properties of a ChannelRoster.
             * @memberof specter.v1
             * @interface IChannelRoster
             * @property {Object.<string,string>|null} [ssrcToUserId] ChannelRoster ssrcToUserId
             */

            /**
             * Constructs a new ChannelRoster.
             * @memberof specter.v1
             * @classdesc Represents a ChannelRoster.
             * @implements IChannelRoster
             * @constructor
             * @param {specter.v1.IChannelRoster=} [properties] Properties to set
             */
            function ChannelRoster(properties) {
                this.ssrcToUserId = {};
                if (properties)
                    for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null)
                            this[keys[i]] = properties[keys[i]];
            }

            /**
             * ChannelRoster ssrcToUserId.
             * @member {Object.<string,string>} ssrcToUserId
             * @memberof specter.v1.ChannelRoster
             * @instance
             */
            ChannelRoster.prototype.ssrcToUserId = $util.emptyObject;

            /**
             * Creates a new ChannelRoster instance using the specified properties.
             * @function create
             * @memberof specter.v1.ChannelRoster
             * @static
             * @param {specter.v1.IChannelRoster=} [properties] Properties to set
             * @returns {specter.v1.ChannelRoster} ChannelRoster instance
             */
            ChannelRoster.create = function create(properties) {
                return new ChannelRoster(properties);
            };

            /**
             * Encodes the specified ChannelRoster message. Does not implicitly {@link specter.v1.ChannelRoster.verify|verify} messages.
             * @function encode
             * @memberof specter.v1.ChannelRoster
             * @static
             * @param {specter.v1.IChannelRoster} message ChannelRoster message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ChannelRoster.encode = function encode(message, writer) {
                if (!writer)
                    writer = $Writer.create();
                if (message.ssrcToUserId != null && Object.hasOwnProperty.call(message, "ssrcToUserId"))
                    for (var keys = Object.keys(message.ssrcToUserId), i = 0; i < keys.length; ++i)
                        writer.uint32(/* id 1, wireType 2 =*/10).fork().uint32(/* id 1, wireType 0 =*/8).uint32(keys[i]).uint32(/* id 2, wireType 2 =*/18).string(message.ssrcToUserId[keys[i]]).ldelim();
                return writer;
            };

            /**
             * Encodes the specified ChannelRoster message, length delimited. Does not implicitly {@link specter.v1.ChannelRoster.verify|verify} messages.
             * @function encodeDelimited
             * @memberof specter.v1.ChannelRoster
             * @static
             * @param {specter.v1.IChannelRoster} message ChannelRoster message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ChannelRoster.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a ChannelRoster message from the specified reader or buffer.
             * @function decode
             * @memberof specter.v1.ChannelRoster
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {specter.v1.ChannelRoster} ChannelRoster
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            ChannelRoster.decode = function decode(reader, length, error) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.specter.v1.ChannelRoster(), key, value;
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            if (message.ssrcToUserId === $util.emptyObject)
                                message.ssrcToUserId = {};
                            var end2 = reader.uint32() + reader.pos;
                            key = 0;
                            value = "";
                            while (reader.pos < end2) {
                                var tag2 = reader.uint32();
                                switch (tag2 >>> 3) {
                                case 1:
                                    key = reader.uint32();
                                    break;
                                case 2:
                                    value = reader.string();
                                    break;
                                default:
                                    reader.skipType(tag2 & 7);
                                    break;
                                }
                            }
                            message.ssrcToUserId[key] = value;
                            break;
                        }
                    default:
                        reader.skipType(tag & 7);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a ChannelRoster message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof specter.v1.ChannelRoster
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {specter.v1.ChannelRoster} ChannelRoster
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            ChannelRoster.decodeDelimited = function decodeDelimited(reader) {
                if (!(reader instanceof $Reader))
                    reader = new $Reader(reader);
                return this.decode(reader, reader.uint32());
            };

            /**
             * Verifies a ChannelRoster message.
             * @function verify
             * @memberof specter.v1.ChannelRoster
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            ChannelRoster.verify = function verify(message) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (message.ssrcToUserId != null && message.hasOwnProperty("ssrcToUserId")) {
                    if (!$util.isObject(message.ssrcToUserId))
                        return "ssrcToUserId: object expected";
                    var key = Object.keys(message.ssrcToUserId);
                    for (var i = 0; i < key.length; ++i) {
                        if (!$util.key32Re.test(key[i]))
                            return "ssrcToUserId: integer key{k:uint32} expected";
                        if (!$util.isString(message.ssrcToUserId[key[i]]))
                            return "ssrcToUserId: string{k:uint32} expected";
                    }
                }
                return null;
            };

            /**
             * Creates a ChannelRoster message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof specter.v1.ChannelRoster
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {specter.v1.ChannelRoster} ChannelRoster
             */
            ChannelRoster.fromObject = function fromObject(object) {
                if (object instanceof $root.specter.v1.ChannelRoster)
                    return object;
                var message = new $root.specter.v1.ChannelRoster();
                if (object.ssrcToUserId) {
                    if (typeof object.ssrcToUserId !== "object")
                        throw TypeError(".specter.v1.ChannelRoster.ssrcToUserId: object expected");
                    message.ssrcToUserId = {};
                    for (var keys = Object.keys(object.ssrcToUserId), i = 0; i < keys.length; ++i)
                        message.ssrcToUserId[keys[i]] = String(object.ssrcToUserId[keys[i]]);
                }
                return message;
            };

            /**
             * Creates a plain object from a ChannelRoster message. Also converts values to other types if specified.
             * @function toObject
             * @memberof specter.v1.ChannelRoster
             * @static
             * @param {specter.v1.ChannelRoster} message ChannelRoster
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            ChannelRoster.toObject = function toObject(message, options) {
                if (!options)
                    options = {};
                var object = {};
                if (options.objects || options.defaults)
                    object.ssrcToUserId = {};
                var keys2;
                if (message.ssrcToUserId && (keys2 = Object.keys(message.ssrcToUserId)).length) {
                    object.ssrcToUserId = {};
                    for (var j = 0; j < keys2.length; ++j)
                        object.ssrcToUserId[keys2[j]] = message.ssrcToUserId[keys2[j]];
                }
                return object;
            };

            /**
             * Converts this ChannelRoster to JSON.
             * @function toJSON
             * @memberof specter.v1.ChannelRoster
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            ChannelRoster.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for ChannelRoster
             * @function getTypeUrl
             * @memberof specter.v1.ChannelRoster
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            ChannelRoster.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/specter.v1.ChannelRoster";
            };

            return ChannelRoster;
        })();

        v1.AudioFrame = (function() {

            /**
             * Properties of an AudioFrame.
             * @memberof specter.v1
             * @interface IAudioFrame
             * @property {Uint8Array|null} [encryptedPayload] AudioFrame encryptedPayload
             * @property {number|null} [ssrc] AudioFrame ssrc
             * @property {number|null} [sequence] AudioFrame sequence
             * @property {boolean|null} [isGlobalBroadcast] AudioFrame isGlobalBroadcast
             * @property {Uint8Array|null} [senderSignature] AudioFrame senderSignature
             */

            /**
             * Constructs a new AudioFrame.
             * @memberof specter.v1
             * @classdesc Represents an AudioFrame.
             * @implements IAudioFrame
             * @constructor
             * @param {specter.v1.IAudioFrame=} [properties] Properties to set
             */
            function AudioFrame(properties) {
                if (properties)
                    for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null)
                            this[keys[i]] = properties[keys[i]];
            }

            /**
             * AudioFrame encryptedPayload.
             * @member {Uint8Array} encryptedPayload
             * @memberof specter.v1.AudioFrame
             * @instance
             */
            AudioFrame.prototype.encryptedPayload = $util.newBuffer([]);

            /**
             * AudioFrame ssrc.
             * @member {number} ssrc
             * @memberof specter.v1.AudioFrame
             * @instance
             */
            AudioFrame.prototype.ssrc = 0;

            /**
             * AudioFrame sequence.
             * @member {number} sequence
             * @memberof specter.v1.AudioFrame
             * @instance
             */
            AudioFrame.prototype.sequence = 0;

            /**
             * AudioFrame isGlobalBroadcast.
             * @member {boolean} isGlobalBroadcast
             * @memberof specter.v1.AudioFrame
             * @instance
             */
            AudioFrame.prototype.isGlobalBroadcast = false;

            /**
             * AudioFrame senderSignature.
             * @member {Uint8Array} senderSignature
             * @memberof specter.v1.AudioFrame
             * @instance
             */
            AudioFrame.prototype.senderSignature = $util.newBuffer([]);

            /**
             * Creates a new AudioFrame instance using the specified properties.
             * @function create
             * @memberof specter.v1.AudioFrame
             * @static
             * @param {specter.v1.IAudioFrame=} [properties] Properties to set
             * @returns {specter.v1.AudioFrame} AudioFrame instance
             */
            AudioFrame.create = function create(properties) {
                return new AudioFrame(properties);
            };

            /**
             * Encodes the specified AudioFrame message. Does not implicitly {@link specter.v1.AudioFrame.verify|verify} messages.
             * @function encode
             * @memberof specter.v1.AudioFrame
             * @static
             * @param {specter.v1.IAudioFrame} message AudioFrame message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            AudioFrame.encode = function encode(message, writer) {
                if (!writer)
                    writer = $Writer.create();
                if (message.encryptedPayload != null && Object.hasOwnProperty.call(message, "encryptedPayload"))
                    writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.encryptedPayload);
                if (message.ssrc != null && Object.hasOwnProperty.call(message, "ssrc"))
                    writer.uint32(/* id 2, wireType 0 =*/16).uint32(message.ssrc);
                if (message.sequence != null && Object.hasOwnProperty.call(message, "sequence"))
                    writer.uint32(/* id 3, wireType 0 =*/24).int32(message.sequence);
                if (message.isGlobalBroadcast != null && Object.hasOwnProperty.call(message, "isGlobalBroadcast"))
                    writer.uint32(/* id 4, wireType 0 =*/32).bool(message.isGlobalBroadcast);
                if (message.senderSignature != null && Object.hasOwnProperty.call(message, "senderSignature"))
                    writer.uint32(/* id 5, wireType 2 =*/42).bytes(message.senderSignature);
                return writer;
            };

            /**
             * Encodes the specified AudioFrame message, length delimited. Does not implicitly {@link specter.v1.AudioFrame.verify|verify} messages.
             * @function encodeDelimited
             * @memberof specter.v1.AudioFrame
             * @static
             * @param {specter.v1.IAudioFrame} message AudioFrame message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            AudioFrame.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes an AudioFrame message from the specified reader or buffer.
             * @function decode
             * @memberof specter.v1.AudioFrame
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {specter.v1.AudioFrame} AudioFrame
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            AudioFrame.decode = function decode(reader, length, error) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.specter.v1.AudioFrame();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.encryptedPayload = reader.bytes();
                            break;
                        }
                    case 2: {
                            message.ssrc = reader.uint32();
                            break;
                        }
                    case 3: {
                            message.sequence = reader.int32();
                            break;
                        }
                    case 4: {
                            message.isGlobalBroadcast = reader.bool();
                            break;
                        }
                    case 5: {
                            message.senderSignature = reader.bytes();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes an AudioFrame message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof specter.v1.AudioFrame
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {specter.v1.AudioFrame} AudioFrame
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            AudioFrame.decodeDelimited = function decodeDelimited(reader) {
                if (!(reader instanceof $Reader))
                    reader = new $Reader(reader);
                return this.decode(reader, reader.uint32());
            };

            /**
             * Verifies an AudioFrame message.
             * @function verify
             * @memberof specter.v1.AudioFrame
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            AudioFrame.verify = function verify(message) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (message.encryptedPayload != null && message.hasOwnProperty("encryptedPayload"))
                    if (!(message.encryptedPayload && typeof message.encryptedPayload.length === "number" || $util.isString(message.encryptedPayload)))
                        return "encryptedPayload: buffer expected";
                if (message.ssrc != null && message.hasOwnProperty("ssrc"))
                    if (!$util.isInteger(message.ssrc))
                        return "ssrc: integer expected";
                if (message.sequence != null && message.hasOwnProperty("sequence"))
                    if (!$util.isInteger(message.sequence))
                        return "sequence: integer expected";
                if (message.isGlobalBroadcast != null && message.hasOwnProperty("isGlobalBroadcast"))
                    if (typeof message.isGlobalBroadcast !== "boolean")
                        return "isGlobalBroadcast: boolean expected";
                if (message.senderSignature != null && message.hasOwnProperty("senderSignature"))
                    if (!(message.senderSignature && typeof message.senderSignature.length === "number" || $util.isString(message.senderSignature)))
                        return "senderSignature: buffer expected";
                return null;
            };

            /**
             * Creates an AudioFrame message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof specter.v1.AudioFrame
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {specter.v1.AudioFrame} AudioFrame
             */
            AudioFrame.fromObject = function fromObject(object) {
                if (object instanceof $root.specter.v1.AudioFrame)
                    return object;
                var message = new $root.specter.v1.AudioFrame();
                if (object.encryptedPayload != null)
                    if (typeof object.encryptedPayload === "string")
                        $util.base64.decode(object.encryptedPayload, message.encryptedPayload = $util.newBuffer($util.base64.length(object.encryptedPayload)), 0);
                    else if (object.encryptedPayload.length >= 0)
                        message.encryptedPayload = object.encryptedPayload;
                if (object.ssrc != null)
                    message.ssrc = object.ssrc >>> 0;
                if (object.sequence != null)
                    message.sequence = object.sequence | 0;
                if (object.isGlobalBroadcast != null)
                    message.isGlobalBroadcast = Boolean(object.isGlobalBroadcast);
                if (object.senderSignature != null)
                    if (typeof object.senderSignature === "string")
                        $util.base64.decode(object.senderSignature, message.senderSignature = $util.newBuffer($util.base64.length(object.senderSignature)), 0);
                    else if (object.senderSignature.length >= 0)
                        message.senderSignature = object.senderSignature;
                return message;
            };

            /**
             * Creates a plain object from an AudioFrame message. Also converts values to other types if specified.
             * @function toObject
             * @memberof specter.v1.AudioFrame
             * @static
             * @param {specter.v1.AudioFrame} message AudioFrame
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            AudioFrame.toObject = function toObject(message, options) {
                if (!options)
                    options = {};
                var object = {};
                if (options.defaults) {
                    if (options.bytes === String)
                        object.encryptedPayload = "";
                    else {
                        object.encryptedPayload = [];
                        if (options.bytes !== Array)
                            object.encryptedPayload = $util.newBuffer(object.encryptedPayload);
                    }
                    object.ssrc = 0;
                    object.sequence = 0;
                    object.isGlobalBroadcast = false;
                    if (options.bytes === String)
                        object.senderSignature = "";
                    else {
                        object.senderSignature = [];
                        if (options.bytes !== Array)
                            object.senderSignature = $util.newBuffer(object.senderSignature);
                    }
                }
                if (message.encryptedPayload != null && message.hasOwnProperty("encryptedPayload"))
                    object.encryptedPayload = options.bytes === String ? $util.base64.encode(message.encryptedPayload, 0, message.encryptedPayload.length) : options.bytes === Array ? Array.prototype.slice.call(message.encryptedPayload) : message.encryptedPayload;
                if (message.ssrc != null && message.hasOwnProperty("ssrc"))
                    object.ssrc = message.ssrc;
                if (message.sequence != null && message.hasOwnProperty("sequence"))
                    object.sequence = message.sequence;
                if (message.isGlobalBroadcast != null && message.hasOwnProperty("isGlobalBroadcast"))
                    object.isGlobalBroadcast = message.isGlobalBroadcast;
                if (message.senderSignature != null && message.hasOwnProperty("senderSignature"))
                    object.senderSignature = options.bytes === String ? $util.base64.encode(message.senderSignature, 0, message.senderSignature.length) : options.bytes === Array ? Array.prototype.slice.call(message.senderSignature) : message.senderSignature;
                return object;
            };

            /**
             * Converts this AudioFrame to JSON.
             * @function toJSON
             * @memberof specter.v1.AudioFrame
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            AudioFrame.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for AudioFrame
             * @function getTypeUrl
             * @memberof specter.v1.AudioFrame
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            AudioFrame.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/specter.v1.AudioFrame";
            };

            return AudioFrame;
        })();

        v1.VideoFrame = (function() {

            /**
             * Properties of a VideoFrame.
             * @memberof specter.v1
             * @interface IVideoFrame
             * @property {Uint8Array|null} [encryptedPayload] VideoFrame encryptedPayload
             * @property {number|null} [ssrc] VideoFrame ssrc
             * @property {number|null} [sequence] VideoFrame sequence
             * @property {boolean|null} [isKeyframe] VideoFrame isKeyframe
             * @property {number|null} [width] VideoFrame width
             * @property {number|null} [height] VideoFrame height
             * @property {boolean|null} [isScreenshare] VideoFrame isScreenshare
             */

            /**
             * Constructs a new VideoFrame.
             * @memberof specter.v1
             * @classdesc Represents a VideoFrame.
             * @implements IVideoFrame
             * @constructor
             * @param {specter.v1.IVideoFrame=} [properties] Properties to set
             */
            function VideoFrame(properties) {
                if (properties)
                    for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null)
                            this[keys[i]] = properties[keys[i]];
            }

            /**
             * VideoFrame encryptedPayload.
             * @member {Uint8Array} encryptedPayload
             * @memberof specter.v1.VideoFrame
             * @instance
             */
            VideoFrame.prototype.encryptedPayload = $util.newBuffer([]);

            /**
             * VideoFrame ssrc.
             * @member {number} ssrc
             * @memberof specter.v1.VideoFrame
             * @instance
             */
            VideoFrame.prototype.ssrc = 0;

            /**
             * VideoFrame sequence.
             * @member {number} sequence
             * @memberof specter.v1.VideoFrame
             * @instance
             */
            VideoFrame.prototype.sequence = 0;

            /**
             * VideoFrame isKeyframe.
             * @member {boolean} isKeyframe
             * @memberof specter.v1.VideoFrame
             * @instance
             */
            VideoFrame.prototype.isKeyframe = false;

            /**
             * VideoFrame width.
             * @member {number} width
             * @memberof specter.v1.VideoFrame
             * @instance
             */
            VideoFrame.prototype.width = 0;

            /**
             * VideoFrame height.
             * @member {number} height
             * @memberof specter.v1.VideoFrame
             * @instance
             */
            VideoFrame.prototype.height = 0;

            /**
             * VideoFrame isScreenshare.
             * @member {boolean} isScreenshare
             * @memberof specter.v1.VideoFrame
             * @instance
             */
            VideoFrame.prototype.isScreenshare = false;

            /**
             * Creates a new VideoFrame instance using the specified properties.
             * @function create
             * @memberof specter.v1.VideoFrame
             * @static
             * @param {specter.v1.IVideoFrame=} [properties] Properties to set
             * @returns {specter.v1.VideoFrame} VideoFrame instance
             */
            VideoFrame.create = function create(properties) {
                return new VideoFrame(properties);
            };

            /**
             * Encodes the specified VideoFrame message. Does not implicitly {@link specter.v1.VideoFrame.verify|verify} messages.
             * @function encode
             * @memberof specter.v1.VideoFrame
             * @static
             * @param {specter.v1.IVideoFrame} message VideoFrame message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            VideoFrame.encode = function encode(message, writer) {
                if (!writer)
                    writer = $Writer.create();
                if (message.encryptedPayload != null && Object.hasOwnProperty.call(message, "encryptedPayload"))
                    writer.uint32(/* id 1, wireType 2 =*/10).bytes(message.encryptedPayload);
                if (message.ssrc != null && Object.hasOwnProperty.call(message, "ssrc"))
                    writer.uint32(/* id 2, wireType 0 =*/16).uint32(message.ssrc);
                if (message.sequence != null && Object.hasOwnProperty.call(message, "sequence"))
                    writer.uint32(/* id 3, wireType 0 =*/24).int32(message.sequence);
                if (message.isKeyframe != null && Object.hasOwnProperty.call(message, "isKeyframe"))
                    writer.uint32(/* id 4, wireType 0 =*/32).bool(message.isKeyframe);
                if (message.width != null && Object.hasOwnProperty.call(message, "width"))
                    writer.uint32(/* id 5, wireType 0 =*/40).int32(message.width);
                if (message.height != null && Object.hasOwnProperty.call(message, "height"))
                    writer.uint32(/* id 6, wireType 0 =*/48).int32(message.height);
                if (message.isScreenshare != null && Object.hasOwnProperty.call(message, "isScreenshare"))
                    writer.uint32(/* id 7, wireType 0 =*/56).bool(message.isScreenshare);
                return writer;
            };

            /**
             * Encodes the specified VideoFrame message, length delimited. Does not implicitly {@link specter.v1.VideoFrame.verify|verify} messages.
             * @function encodeDelimited
             * @memberof specter.v1.VideoFrame
             * @static
             * @param {specter.v1.IVideoFrame} message VideoFrame message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            VideoFrame.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a VideoFrame message from the specified reader or buffer.
             * @function decode
             * @memberof specter.v1.VideoFrame
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {specter.v1.VideoFrame} VideoFrame
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            VideoFrame.decode = function decode(reader, length, error) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.specter.v1.VideoFrame();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.encryptedPayload = reader.bytes();
                            break;
                        }
                    case 2: {
                            message.ssrc = reader.uint32();
                            break;
                        }
                    case 3: {
                            message.sequence = reader.int32();
                            break;
                        }
                    case 4: {
                            message.isKeyframe = reader.bool();
                            break;
                        }
                    case 5: {
                            message.width = reader.int32();
                            break;
                        }
                    case 6: {
                            message.height = reader.int32();
                            break;
                        }
                    case 7: {
                            message.isScreenshare = reader.bool();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a VideoFrame message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof specter.v1.VideoFrame
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {specter.v1.VideoFrame} VideoFrame
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            VideoFrame.decodeDelimited = function decodeDelimited(reader) {
                if (!(reader instanceof $Reader))
                    reader = new $Reader(reader);
                return this.decode(reader, reader.uint32());
            };

            /**
             * Verifies a VideoFrame message.
             * @function verify
             * @memberof specter.v1.VideoFrame
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            VideoFrame.verify = function verify(message) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (message.encryptedPayload != null && message.hasOwnProperty("encryptedPayload"))
                    if (!(message.encryptedPayload && typeof message.encryptedPayload.length === "number" || $util.isString(message.encryptedPayload)))
                        return "encryptedPayload: buffer expected";
                if (message.ssrc != null && message.hasOwnProperty("ssrc"))
                    if (!$util.isInteger(message.ssrc))
                        return "ssrc: integer expected";
                if (message.sequence != null && message.hasOwnProperty("sequence"))
                    if (!$util.isInteger(message.sequence))
                        return "sequence: integer expected";
                if (message.isKeyframe != null && message.hasOwnProperty("isKeyframe"))
                    if (typeof message.isKeyframe !== "boolean")
                        return "isKeyframe: boolean expected";
                if (message.width != null && message.hasOwnProperty("width"))
                    if (!$util.isInteger(message.width))
                        return "width: integer expected";
                if (message.height != null && message.hasOwnProperty("height"))
                    if (!$util.isInteger(message.height))
                        return "height: integer expected";
                if (message.isScreenshare != null && message.hasOwnProperty("isScreenshare"))
                    if (typeof message.isScreenshare !== "boolean")
                        return "isScreenshare: boolean expected";
                return null;
            };

            /**
             * Creates a VideoFrame message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof specter.v1.VideoFrame
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {specter.v1.VideoFrame} VideoFrame
             */
            VideoFrame.fromObject = function fromObject(object) {
                if (object instanceof $root.specter.v1.VideoFrame)
                    return object;
                var message = new $root.specter.v1.VideoFrame();
                if (object.encryptedPayload != null)
                    if (typeof object.encryptedPayload === "string")
                        $util.base64.decode(object.encryptedPayload, message.encryptedPayload = $util.newBuffer($util.base64.length(object.encryptedPayload)), 0);
                    else if (object.encryptedPayload.length >= 0)
                        message.encryptedPayload = object.encryptedPayload;
                if (object.ssrc != null)
                    message.ssrc = object.ssrc >>> 0;
                if (object.sequence != null)
                    message.sequence = object.sequence | 0;
                if (object.isKeyframe != null)
                    message.isKeyframe = Boolean(object.isKeyframe);
                if (object.width != null)
                    message.width = object.width | 0;
                if (object.height != null)
                    message.height = object.height | 0;
                if (object.isScreenshare != null)
                    message.isScreenshare = Boolean(object.isScreenshare);
                return message;
            };

            /**
             * Creates a plain object from a VideoFrame message. Also converts values to other types if specified.
             * @function toObject
             * @memberof specter.v1.VideoFrame
             * @static
             * @param {specter.v1.VideoFrame} message VideoFrame
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            VideoFrame.toObject = function toObject(message, options) {
                if (!options)
                    options = {};
                var object = {};
                if (options.defaults) {
                    if (options.bytes === String)
                        object.encryptedPayload = "";
                    else {
                        object.encryptedPayload = [];
                        if (options.bytes !== Array)
                            object.encryptedPayload = $util.newBuffer(object.encryptedPayload);
                    }
                    object.ssrc = 0;
                    object.sequence = 0;
                    object.isKeyframe = false;
                    object.width = 0;
                    object.height = 0;
                    object.isScreenshare = false;
                }
                if (message.encryptedPayload != null && message.hasOwnProperty("encryptedPayload"))
                    object.encryptedPayload = options.bytes === String ? $util.base64.encode(message.encryptedPayload, 0, message.encryptedPayload.length) : options.bytes === Array ? Array.prototype.slice.call(message.encryptedPayload) : message.encryptedPayload;
                if (message.ssrc != null && message.hasOwnProperty("ssrc"))
                    object.ssrc = message.ssrc;
                if (message.sequence != null && message.hasOwnProperty("sequence"))
                    object.sequence = message.sequence;
                if (message.isKeyframe != null && message.hasOwnProperty("isKeyframe"))
                    object.isKeyframe = message.isKeyframe;
                if (message.width != null && message.hasOwnProperty("width"))
                    object.width = message.width;
                if (message.height != null && message.hasOwnProperty("height"))
                    object.height = message.height;
                if (message.isScreenshare != null && message.hasOwnProperty("isScreenshare"))
                    object.isScreenshare = message.isScreenshare;
                return object;
            };

            /**
             * Converts this VideoFrame to JSON.
             * @function toJSON
             * @memberof specter.v1.VideoFrame
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            VideoFrame.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for VideoFrame
             * @function getTypeUrl
             * @memberof specter.v1.VideoFrame
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            VideoFrame.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/specter.v1.VideoFrame";
            };

            return VideoFrame;
        })();

        v1.ModerationAction = (function() {

            /**
             * Properties of a ModerationAction.
             * @memberof specter.v1
             * @interface IModerationAction
             * @property {string|null} [adminId] ModerationAction adminId
             * @property {string|null} [targetId] ModerationAction targetId
             * @property {string|null} [orgId] ModerationAction orgId
             * @property {specter.v1.ModerationAction.ActionType|null} [action] ModerationAction action
             * @property {string|null} [reason] ModerationAction reason
             * @property {string|null} [targetChannelId] ModerationAction targetChannelId
             */

            /**
             * Constructs a new ModerationAction.
             * @memberof specter.v1
             * @classdesc Represents a ModerationAction.
             * @implements IModerationAction
             * @constructor
             * @param {specter.v1.IModerationAction=} [properties] Properties to set
             */
            function ModerationAction(properties) {
                if (properties)
                    for (var keys = Object.keys(properties), i = 0; i < keys.length; ++i)
                        if (properties[keys[i]] != null)
                            this[keys[i]] = properties[keys[i]];
            }

            /**
             * ModerationAction adminId.
             * @member {string} adminId
             * @memberof specter.v1.ModerationAction
             * @instance
             */
            ModerationAction.prototype.adminId = "";

            /**
             * ModerationAction targetId.
             * @member {string} targetId
             * @memberof specter.v1.ModerationAction
             * @instance
             */
            ModerationAction.prototype.targetId = "";

            /**
             * ModerationAction orgId.
             * @member {string} orgId
             * @memberof specter.v1.ModerationAction
             * @instance
             */
            ModerationAction.prototype.orgId = "";

            /**
             * ModerationAction action.
             * @member {specter.v1.ModerationAction.ActionType} action
             * @memberof specter.v1.ModerationAction
             * @instance
             */
            ModerationAction.prototype.action = 0;

            /**
             * ModerationAction reason.
             * @member {string} reason
             * @memberof specter.v1.ModerationAction
             * @instance
             */
            ModerationAction.prototype.reason = "";

            /**
             * ModerationAction targetChannelId.
             * @member {string} targetChannelId
             * @memberof specter.v1.ModerationAction
             * @instance
             */
            ModerationAction.prototype.targetChannelId = "";

            /**
             * Creates a new ModerationAction instance using the specified properties.
             * @function create
             * @memberof specter.v1.ModerationAction
             * @static
             * @param {specter.v1.IModerationAction=} [properties] Properties to set
             * @returns {specter.v1.ModerationAction} ModerationAction instance
             */
            ModerationAction.create = function create(properties) {
                return new ModerationAction(properties);
            };

            /**
             * Encodes the specified ModerationAction message. Does not implicitly {@link specter.v1.ModerationAction.verify|verify} messages.
             * @function encode
             * @memberof specter.v1.ModerationAction
             * @static
             * @param {specter.v1.IModerationAction} message ModerationAction message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ModerationAction.encode = function encode(message, writer) {
                if (!writer)
                    writer = $Writer.create();
                if (message.adminId != null && Object.hasOwnProperty.call(message, "adminId"))
                    writer.uint32(/* id 1, wireType 2 =*/10).string(message.adminId);
                if (message.targetId != null && Object.hasOwnProperty.call(message, "targetId"))
                    writer.uint32(/* id 2, wireType 2 =*/18).string(message.targetId);
                if (message.orgId != null && Object.hasOwnProperty.call(message, "orgId"))
                    writer.uint32(/* id 3, wireType 2 =*/26).string(message.orgId);
                if (message.action != null && Object.hasOwnProperty.call(message, "action"))
                    writer.uint32(/* id 4, wireType 0 =*/32).int32(message.action);
                if (message.reason != null && Object.hasOwnProperty.call(message, "reason"))
                    writer.uint32(/* id 5, wireType 2 =*/42).string(message.reason);
                if (message.targetChannelId != null && Object.hasOwnProperty.call(message, "targetChannelId"))
                    writer.uint32(/* id 6, wireType 2 =*/50).string(message.targetChannelId);
                return writer;
            };

            /**
             * Encodes the specified ModerationAction message, length delimited. Does not implicitly {@link specter.v1.ModerationAction.verify|verify} messages.
             * @function encodeDelimited
             * @memberof specter.v1.ModerationAction
             * @static
             * @param {specter.v1.IModerationAction} message ModerationAction message or plain object to encode
             * @param {$protobuf.Writer} [writer] Writer to encode to
             * @returns {$protobuf.Writer} Writer
             */
            ModerationAction.encodeDelimited = function encodeDelimited(message, writer) {
                return this.encode(message, writer).ldelim();
            };

            /**
             * Decodes a ModerationAction message from the specified reader or buffer.
             * @function decode
             * @memberof specter.v1.ModerationAction
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @param {number} [length] Message length if known beforehand
             * @returns {specter.v1.ModerationAction} ModerationAction
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            ModerationAction.decode = function decode(reader, length, error) {
                if (!(reader instanceof $Reader))
                    reader = $Reader.create(reader);
                var end = length === undefined ? reader.len : reader.pos + length, message = new $root.specter.v1.ModerationAction();
                while (reader.pos < end) {
                    var tag = reader.uint32();
                    if (tag === error)
                        break;
                    switch (tag >>> 3) {
                    case 1: {
                            message.adminId = reader.string();
                            break;
                        }
                    case 2: {
                            message.targetId = reader.string();
                            break;
                        }
                    case 3: {
                            message.orgId = reader.string();
                            break;
                        }
                    case 4: {
                            message.action = reader.int32();
                            break;
                        }
                    case 5: {
                            message.reason = reader.string();
                            break;
                        }
                    case 6: {
                            message.targetChannelId = reader.string();
                            break;
                        }
                    default:
                        reader.skipType(tag & 7);
                        break;
                    }
                }
                return message;
            };

            /**
             * Decodes a ModerationAction message from the specified reader or buffer, length delimited.
             * @function decodeDelimited
             * @memberof specter.v1.ModerationAction
             * @static
             * @param {$protobuf.Reader|Uint8Array} reader Reader or buffer to decode from
             * @returns {specter.v1.ModerationAction} ModerationAction
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            ModerationAction.decodeDelimited = function decodeDelimited(reader) {
                if (!(reader instanceof $Reader))
                    reader = new $Reader(reader);
                return this.decode(reader, reader.uint32());
            };

            /**
             * Verifies a ModerationAction message.
             * @function verify
             * @memberof specter.v1.ModerationAction
             * @static
             * @param {Object.<string,*>} message Plain object to verify
             * @returns {string|null} `null` if valid, otherwise the reason why it is not
             */
            ModerationAction.verify = function verify(message) {
                if (typeof message !== "object" || message === null)
                    return "object expected";
                if (message.adminId != null && message.hasOwnProperty("adminId"))
                    if (!$util.isString(message.adminId))
                        return "adminId: string expected";
                if (message.targetId != null && message.hasOwnProperty("targetId"))
                    if (!$util.isString(message.targetId))
                        return "targetId: string expected";
                if (message.orgId != null && message.hasOwnProperty("orgId"))
                    if (!$util.isString(message.orgId))
                        return "orgId: string expected";
                if (message.action != null && message.hasOwnProperty("action"))
                    switch (message.action) {
                    default:
                        return "action: enum value expected";
                    case 0:
                    case 1:
                    case 2:
                    case 3:
                        break;
                    }
                if (message.reason != null && message.hasOwnProperty("reason"))
                    if (!$util.isString(message.reason))
                        return "reason: string expected";
                if (message.targetChannelId != null && message.hasOwnProperty("targetChannelId"))
                    if (!$util.isString(message.targetChannelId))
                        return "targetChannelId: string expected";
                return null;
            };

            /**
             * Creates a ModerationAction message from a plain object. Also converts values to their respective internal types.
             * @function fromObject
             * @memberof specter.v1.ModerationAction
             * @static
             * @param {Object.<string,*>} object Plain object
             * @returns {specter.v1.ModerationAction} ModerationAction
             */
            ModerationAction.fromObject = function fromObject(object) {
                if (object instanceof $root.specter.v1.ModerationAction)
                    return object;
                var message = new $root.specter.v1.ModerationAction();
                if (object.adminId != null)
                    message.adminId = String(object.adminId);
                if (object.targetId != null)
                    message.targetId = String(object.targetId);
                if (object.orgId != null)
                    message.orgId = String(object.orgId);
                switch (object.action) {
                default:
                    if (typeof object.action === "number") {
                        message.action = object.action;
                        break;
                    }
                    break;
                case "KICK":
                case 0:
                    message.action = 0;
                    break;
                case "BAN":
                case 1:
                    message.action = 1;
                    break;
                case "MUTE":
                case 2:
                    message.action = 2;
                    break;
                case "MOVE":
                case 3:
                    message.action = 3;
                    break;
                }
                if (object.reason != null)
                    message.reason = String(object.reason);
                if (object.targetChannelId != null)
                    message.targetChannelId = String(object.targetChannelId);
                return message;
            };

            /**
             * Creates a plain object from a ModerationAction message. Also converts values to other types if specified.
             * @function toObject
             * @memberof specter.v1.ModerationAction
             * @static
             * @param {specter.v1.ModerationAction} message ModerationAction
             * @param {$protobuf.IConversionOptions} [options] Conversion options
             * @returns {Object.<string,*>} Plain object
             */
            ModerationAction.toObject = function toObject(message, options) {
                if (!options)
                    options = {};
                var object = {};
                if (options.defaults) {
                    object.adminId = "";
                    object.targetId = "";
                    object.orgId = "";
                    object.action = options.enums === String ? "KICK" : 0;
                    object.reason = "";
                    object.targetChannelId = "";
                }
                if (message.adminId != null && message.hasOwnProperty("adminId"))
                    object.adminId = message.adminId;
                if (message.targetId != null && message.hasOwnProperty("targetId"))
                    object.targetId = message.targetId;
                if (message.orgId != null && message.hasOwnProperty("orgId"))
                    object.orgId = message.orgId;
                if (message.action != null && message.hasOwnProperty("action"))
                    object.action = options.enums === String ? $root.specter.v1.ModerationAction.ActionType[message.action] === undefined ? message.action : $root.specter.v1.ModerationAction.ActionType[message.action] : message.action;
                if (message.reason != null && message.hasOwnProperty("reason"))
                    object.reason = message.reason;
                if (message.targetChannelId != null && message.hasOwnProperty("targetChannelId"))
                    object.targetChannelId = message.targetChannelId;
                return object;
            };

            /**
             * Converts this ModerationAction to JSON.
             * @function toJSON
             * @memberof specter.v1.ModerationAction
             * @instance
             * @returns {Object.<string,*>} JSON object
             */
            ModerationAction.prototype.toJSON = function toJSON() {
                return this.constructor.toObject(this, $protobuf.util.toJSONOptions);
            };

            /**
             * Gets the default type url for ModerationAction
             * @function getTypeUrl
             * @memberof specter.v1.ModerationAction
             * @static
             * @param {string} [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns {string} The default type url
             */
            ModerationAction.getTypeUrl = function getTypeUrl(typeUrlPrefix) {
                if (typeUrlPrefix === undefined) {
                    typeUrlPrefix = "type.googleapis.com";
                }
                return typeUrlPrefix + "/specter.v1.ModerationAction";
            };

            /**
             * ActionType enum.
             * @name specter.v1.ModerationAction.ActionType
             * @enum {number}
             * @property {number} KICK=0 KICK value
             * @property {number} BAN=1 BAN value
             * @property {number} MUTE=2 MUTE value
             * @property {number} MOVE=3 MOVE value
             */
            ModerationAction.ActionType = (function() {
                var valuesById = {}, values = Object.create(valuesById);
                values[valuesById[0] = "KICK"] = 0;
                values[valuesById[1] = "BAN"] = 1;
                values[valuesById[2] = "MUTE"] = 2;
                values[valuesById[3] = "MOVE"] = 3;
                return values;
            })();

            return ModerationAction;
        })();

        return v1;
    })();

    return specter;
})();

module.exports = $root;
