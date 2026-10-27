import * as $protobuf from "protobufjs";
import Long = require("long");
/** Namespace specter. */
export namespace specter {

    /** Namespace v1. */
    namespace v1 {

        /** CommsTier enum. */
        enum CommsTier {
            TIER_UNSPECIFIED = 0,
            TIER_COMMANDER = 1,
            TIER_OFFICER = 2,
            TIER_OPERATIVE = 3
        }

        /** PriorityLevel enum. */
        enum PriorityLevel {
            PRIORITY_UNSPECIFIED = 0,
            PRIORITY_GLOBAL_ADMIN = 1,
            PRIORITY_GROUP_LEADER = 2,
            PRIORITY_MEMBER = 3,
            PRIORITY_LISTENER = 4
        }

        /** Properties of a ShipSession. */
        interface IShipSession {

            /** ShipSession shipId */
            shipId?: (string|null);

            /** ShipSession fleetId */
            fleetId?: (string|null);

            /** ShipSession userTier */
            userTier?: (specter.v1.CommsTier|null);
        }

        /** Represents a ShipSession. */
        class ShipSession implements IShipSession {

            /**
             * Constructs a new ShipSession.
             * @param [properties] Properties to set
             */
            constructor(properties?: specter.v1.IShipSession);

            /** ShipSession shipId. */
            public shipId: string;

            /** ShipSession fleetId. */
            public fleetId: string;

            /** ShipSession userTier. */
            public userTier: specter.v1.CommsTier;

            /**
             * Creates a new ShipSession instance using the specified properties.
             * @param [properties] Properties to set
             * @returns ShipSession instance
             */
            public static create(properties?: specter.v1.IShipSession): specter.v1.ShipSession;

            /**
             * Encodes the specified ShipSession message. Does not implicitly {@link specter.v1.ShipSession.verify|verify} messages.
             * @param message ShipSession message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encode(message: specter.v1.IShipSession, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Encodes the specified ShipSession message, length delimited. Does not implicitly {@link specter.v1.ShipSession.verify|verify} messages.
             * @param message ShipSession message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encodeDelimited(message: specter.v1.IShipSession, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Decodes a ShipSession message from the specified reader or buffer.
             * @param reader Reader or buffer to decode from
             * @param [length] Message length if known beforehand
             * @returns ShipSession
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): specter.v1.ShipSession;

            /**
             * Decodes a ShipSession message from the specified reader or buffer, length delimited.
             * @param reader Reader or buffer to decode from
             * @returns ShipSession
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): specter.v1.ShipSession;

            /**
             * Verifies a ShipSession message.
             * @param message Plain object to verify
             * @returns `null` if valid, otherwise the reason why it is not
             */
            public static verify(message: { [k: string]: any }): (string|null);

            /**
             * Creates a ShipSession message from a plain object. Also converts values to their respective internal types.
             * @param object Plain object
             * @returns ShipSession
             */
            public static fromObject(object: { [k: string]: any }): specter.v1.ShipSession;

            /**
             * Creates a plain object from a ShipSession message. Also converts values to other types if specified.
             * @param message ShipSession
             * @param [options] Conversion options
             * @returns Plain object
             */
            public static toObject(message: specter.v1.ShipSession, options?: $protobuf.IConversionOptions): { [k: string]: any };

            /**
             * Converts this ShipSession to JSON.
             * @returns JSON object
             */
            public toJSON(): { [k: string]: any };

            /**
             * Gets the default type url for ShipSession
             * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns The default type url
             */
            public static getTypeUrl(typeUrlPrefix?: string): string;
        }

        /** Properties of a MissionEvent. */
        interface IMissionEvent {

            /** MissionEvent eventId */
            eventId?: (string|null);

            /** MissionEvent startTime */
            startTime?: (number|Long|null);

            /** MissionEvent endTime */
            endTime?: (number|Long|null);
        }

        /** Represents a MissionEvent. */
        class MissionEvent implements IMissionEvent {

            /**
             * Constructs a new MissionEvent.
             * @param [properties] Properties to set
             */
            constructor(properties?: specter.v1.IMissionEvent);

            /** MissionEvent eventId. */
            public eventId: string;

            /** MissionEvent startTime. */
            public startTime: (number|Long);

            /** MissionEvent endTime. */
            public endTime: (number|Long);

            /**
             * Creates a new MissionEvent instance using the specified properties.
             * @param [properties] Properties to set
             * @returns MissionEvent instance
             */
            public static create(properties?: specter.v1.IMissionEvent): specter.v1.MissionEvent;

            /**
             * Encodes the specified MissionEvent message. Does not implicitly {@link specter.v1.MissionEvent.verify|verify} messages.
             * @param message MissionEvent message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encode(message: specter.v1.IMissionEvent, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Encodes the specified MissionEvent message, length delimited. Does not implicitly {@link specter.v1.MissionEvent.verify|verify} messages.
             * @param message MissionEvent message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encodeDelimited(message: specter.v1.IMissionEvent, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Decodes a MissionEvent message from the specified reader or buffer.
             * @param reader Reader or buffer to decode from
             * @param [length] Message length if known beforehand
             * @returns MissionEvent
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): specter.v1.MissionEvent;

            /**
             * Decodes a MissionEvent message from the specified reader or buffer, length delimited.
             * @param reader Reader or buffer to decode from
             * @returns MissionEvent
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): specter.v1.MissionEvent;

            /**
             * Verifies a MissionEvent message.
             * @param message Plain object to verify
             * @returns `null` if valid, otherwise the reason why it is not
             */
            public static verify(message: { [k: string]: any }): (string|null);

            /**
             * Creates a MissionEvent message from a plain object. Also converts values to their respective internal types.
             * @param object Plain object
             * @returns MissionEvent
             */
            public static fromObject(object: { [k: string]: any }): specter.v1.MissionEvent;

            /**
             * Creates a plain object from a MissionEvent message. Also converts values to other types if specified.
             * @param message MissionEvent
             * @param [options] Conversion options
             * @returns Plain object
             */
            public static toObject(message: specter.v1.MissionEvent, options?: $protobuf.IConversionOptions): { [k: string]: any };

            /**
             * Converts this MissionEvent to JSON.
             * @returns JSON object
             */
            public toJSON(): { [k: string]: any };

            /**
             * Gets the default type url for MissionEvent
             * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns The default type url
             */
            public static getTypeUrl(typeUrlPrefix?: string): string;
        }

        /** Properties of a UserSession. */
        interface IUserSession {

            /** UserSession userId */
            userId?: (string|null);

            /** UserSession sessionId */
            sessionId?: (string|null);

            /** UserSession priority */
            priority?: (specter.v1.PriorityLevel|null);

            /** UserSession currentChannelId */
            currentChannelId?: (string|null);

            /** UserSession isMuted */
            isMuted?: (boolean|null);

            /** UserSession isDeafened */
            isDeafened?: (boolean|null);

            /** UserSession ssrc */
            ssrc?: (number|null);
        }

        /** Represents a UserSession. */
        class UserSession implements IUserSession {

            /**
             * Constructs a new UserSession.
             * @param [properties] Properties to set
             */
            constructor(properties?: specter.v1.IUserSession);

            /** UserSession userId. */
            public userId: string;

            /** UserSession sessionId. */
            public sessionId: string;

            /** UserSession priority. */
            public priority: specter.v1.PriorityLevel;

            /** UserSession currentChannelId. */
            public currentChannelId: string;

            /** UserSession isMuted. */
            public isMuted: boolean;

            /** UserSession isDeafened. */
            public isDeafened: boolean;

            /** UserSession ssrc. */
            public ssrc: number;

            /**
             * Creates a new UserSession instance using the specified properties.
             * @param [properties] Properties to set
             * @returns UserSession instance
             */
            public static create(properties?: specter.v1.IUserSession): specter.v1.UserSession;

            /**
             * Encodes the specified UserSession message. Does not implicitly {@link specter.v1.UserSession.verify|verify} messages.
             * @param message UserSession message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encode(message: specter.v1.IUserSession, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Encodes the specified UserSession message, length delimited. Does not implicitly {@link specter.v1.UserSession.verify|verify} messages.
             * @param message UserSession message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encodeDelimited(message: specter.v1.IUserSession, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Decodes a UserSession message from the specified reader or buffer.
             * @param reader Reader or buffer to decode from
             * @param [length] Message length if known beforehand
             * @returns UserSession
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): specter.v1.UserSession;

            /**
             * Decodes a UserSession message from the specified reader or buffer, length delimited.
             * @param reader Reader or buffer to decode from
             * @returns UserSession
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): specter.v1.UserSession;

            /**
             * Verifies a UserSession message.
             * @param message Plain object to verify
             * @returns `null` if valid, otherwise the reason why it is not
             */
            public static verify(message: { [k: string]: any }): (string|null);

            /**
             * Creates a UserSession message from a plain object. Also converts values to their respective internal types.
             * @param object Plain object
             * @returns UserSession
             */
            public static fromObject(object: { [k: string]: any }): specter.v1.UserSession;

            /**
             * Creates a plain object from a UserSession message. Also converts values to other types if specified.
             * @param message UserSession
             * @param [options] Conversion options
             * @returns Plain object
             */
            public static toObject(message: specter.v1.UserSession, options?: $protobuf.IConversionOptions): { [k: string]: any };

            /**
             * Converts this UserSession to JSON.
             * @returns JSON object
             */
            public toJSON(): { [k: string]: any };

            /**
             * Gets the default type url for UserSession
             * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns The default type url
             */
            public static getTypeUrl(typeUrlPrefix?: string): string;
        }

        /** Properties of a ChannelRoster. */
        interface IChannelRoster {

            /** ChannelRoster ssrcToUserId */
            ssrcToUserId?: ({ [k: string]: string }|null);
        }

        /** Represents a ChannelRoster. */
        class ChannelRoster implements IChannelRoster {

            /**
             * Constructs a new ChannelRoster.
             * @param [properties] Properties to set
             */
            constructor(properties?: specter.v1.IChannelRoster);

            /** ChannelRoster ssrcToUserId. */
            public ssrcToUserId: { [k: string]: string };

            /**
             * Creates a new ChannelRoster instance using the specified properties.
             * @param [properties] Properties to set
             * @returns ChannelRoster instance
             */
            public static create(properties?: specter.v1.IChannelRoster): specter.v1.ChannelRoster;

            /**
             * Encodes the specified ChannelRoster message. Does not implicitly {@link specter.v1.ChannelRoster.verify|verify} messages.
             * @param message ChannelRoster message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encode(message: specter.v1.IChannelRoster, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Encodes the specified ChannelRoster message, length delimited. Does not implicitly {@link specter.v1.ChannelRoster.verify|verify} messages.
             * @param message ChannelRoster message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encodeDelimited(message: specter.v1.IChannelRoster, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Decodes a ChannelRoster message from the specified reader or buffer.
             * @param reader Reader or buffer to decode from
             * @param [length] Message length if known beforehand
             * @returns ChannelRoster
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): specter.v1.ChannelRoster;

            /**
             * Decodes a ChannelRoster message from the specified reader or buffer, length delimited.
             * @param reader Reader or buffer to decode from
             * @returns ChannelRoster
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): specter.v1.ChannelRoster;

            /**
             * Verifies a ChannelRoster message.
             * @param message Plain object to verify
             * @returns `null` if valid, otherwise the reason why it is not
             */
            public static verify(message: { [k: string]: any }): (string|null);

            /**
             * Creates a ChannelRoster message from a plain object. Also converts values to their respective internal types.
             * @param object Plain object
             * @returns ChannelRoster
             */
            public static fromObject(object: { [k: string]: any }): specter.v1.ChannelRoster;

            /**
             * Creates a plain object from a ChannelRoster message. Also converts values to other types if specified.
             * @param message ChannelRoster
             * @param [options] Conversion options
             * @returns Plain object
             */
            public static toObject(message: specter.v1.ChannelRoster, options?: $protobuf.IConversionOptions): { [k: string]: any };

            /**
             * Converts this ChannelRoster to JSON.
             * @returns JSON object
             */
            public toJSON(): { [k: string]: any };

            /**
             * Gets the default type url for ChannelRoster
             * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns The default type url
             */
            public static getTypeUrl(typeUrlPrefix?: string): string;
        }

        /** Properties of an AudioFrame. */
        interface IAudioFrame {

            /** AudioFrame encryptedPayload */
            encryptedPayload?: (Uint8Array|null);

            /** AudioFrame ssrc */
            ssrc?: (number|null);

            /** AudioFrame sequence */
            sequence?: (number|null);

            /** AudioFrame isGlobalBroadcast */
            isGlobalBroadcast?: (boolean|null);

            /** AudioFrame senderSignature */
            senderSignature?: (Uint8Array|null);
        }

        /** Represents an AudioFrame. */
        class AudioFrame implements IAudioFrame {

            /**
             * Constructs a new AudioFrame.
             * @param [properties] Properties to set
             */
            constructor(properties?: specter.v1.IAudioFrame);

            /** AudioFrame encryptedPayload. */
            public encryptedPayload: Uint8Array;

            /** AudioFrame ssrc. */
            public ssrc: number;

            /** AudioFrame sequence. */
            public sequence: number;

            /** AudioFrame isGlobalBroadcast. */
            public isGlobalBroadcast: boolean;

            /** AudioFrame senderSignature. */
            public senderSignature: Uint8Array;

            /**
             * Creates a new AudioFrame instance using the specified properties.
             * @param [properties] Properties to set
             * @returns AudioFrame instance
             */
            public static create(properties?: specter.v1.IAudioFrame): specter.v1.AudioFrame;

            /**
             * Encodes the specified AudioFrame message. Does not implicitly {@link specter.v1.AudioFrame.verify|verify} messages.
             * @param message AudioFrame message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encode(message: specter.v1.IAudioFrame, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Encodes the specified AudioFrame message, length delimited. Does not implicitly {@link specter.v1.AudioFrame.verify|verify} messages.
             * @param message AudioFrame message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encodeDelimited(message: specter.v1.IAudioFrame, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Decodes an AudioFrame message from the specified reader or buffer.
             * @param reader Reader or buffer to decode from
             * @param [length] Message length if known beforehand
             * @returns AudioFrame
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): specter.v1.AudioFrame;

            /**
             * Decodes an AudioFrame message from the specified reader or buffer, length delimited.
             * @param reader Reader or buffer to decode from
             * @returns AudioFrame
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): specter.v1.AudioFrame;

            /**
             * Verifies an AudioFrame message.
             * @param message Plain object to verify
             * @returns `null` if valid, otherwise the reason why it is not
             */
            public static verify(message: { [k: string]: any }): (string|null);

            /**
             * Creates an AudioFrame message from a plain object. Also converts values to their respective internal types.
             * @param object Plain object
             * @returns AudioFrame
             */
            public static fromObject(object: { [k: string]: any }): specter.v1.AudioFrame;

            /**
             * Creates a plain object from an AudioFrame message. Also converts values to other types if specified.
             * @param message AudioFrame
             * @param [options] Conversion options
             * @returns Plain object
             */
            public static toObject(message: specter.v1.AudioFrame, options?: $protobuf.IConversionOptions): { [k: string]: any };

            /**
             * Converts this AudioFrame to JSON.
             * @returns JSON object
             */
            public toJSON(): { [k: string]: any };

            /**
             * Gets the default type url for AudioFrame
             * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns The default type url
             */
            public static getTypeUrl(typeUrlPrefix?: string): string;
        }

        /** Properties of a VideoFrame. */
        interface IVideoFrame {

            /** VideoFrame encryptedPayload */
            encryptedPayload?: (Uint8Array|null);

            /** VideoFrame ssrc */
            ssrc?: (number|null);

            /** VideoFrame sequence */
            sequence?: (number|null);

            /** VideoFrame isKeyframe */
            isKeyframe?: (boolean|null);

            /** VideoFrame width */
            width?: (number|null);

            /** VideoFrame height */
            height?: (number|null);

            /** VideoFrame isScreenshare */
            isScreenshare?: (boolean|null);
        }

        /** Represents a VideoFrame. */
        class VideoFrame implements IVideoFrame {

            /**
             * Constructs a new VideoFrame.
             * @param [properties] Properties to set
             */
            constructor(properties?: specter.v1.IVideoFrame);

            /** VideoFrame encryptedPayload. */
            public encryptedPayload: Uint8Array;

            /** VideoFrame ssrc. */
            public ssrc: number;

            /** VideoFrame sequence. */
            public sequence: number;

            /** VideoFrame isKeyframe. */
            public isKeyframe: boolean;

            /** VideoFrame width. */
            public width: number;

            /** VideoFrame height. */
            public height: number;

            /** VideoFrame isScreenshare. */
            public isScreenshare: boolean;

            /**
             * Creates a new VideoFrame instance using the specified properties.
             * @param [properties] Properties to set
             * @returns VideoFrame instance
             */
            public static create(properties?: specter.v1.IVideoFrame): specter.v1.VideoFrame;

            /**
             * Encodes the specified VideoFrame message. Does not implicitly {@link specter.v1.VideoFrame.verify|verify} messages.
             * @param message VideoFrame message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encode(message: specter.v1.IVideoFrame, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Encodes the specified VideoFrame message, length delimited. Does not implicitly {@link specter.v1.VideoFrame.verify|verify} messages.
             * @param message VideoFrame message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encodeDelimited(message: specter.v1.IVideoFrame, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Decodes a VideoFrame message from the specified reader or buffer.
             * @param reader Reader or buffer to decode from
             * @param [length] Message length if known beforehand
             * @returns VideoFrame
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): specter.v1.VideoFrame;

            /**
             * Decodes a VideoFrame message from the specified reader or buffer, length delimited.
             * @param reader Reader or buffer to decode from
             * @returns VideoFrame
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): specter.v1.VideoFrame;

            /**
             * Verifies a VideoFrame message.
             * @param message Plain object to verify
             * @returns `null` if valid, otherwise the reason why it is not
             */
            public static verify(message: { [k: string]: any }): (string|null);

            /**
             * Creates a VideoFrame message from a plain object. Also converts values to their respective internal types.
             * @param object Plain object
             * @returns VideoFrame
             */
            public static fromObject(object: { [k: string]: any }): specter.v1.VideoFrame;

            /**
             * Creates a plain object from a VideoFrame message. Also converts values to other types if specified.
             * @param message VideoFrame
             * @param [options] Conversion options
             * @returns Plain object
             */
            public static toObject(message: specter.v1.VideoFrame, options?: $protobuf.IConversionOptions): { [k: string]: any };

            /**
             * Converts this VideoFrame to JSON.
             * @returns JSON object
             */
            public toJSON(): { [k: string]: any };

            /**
             * Gets the default type url for VideoFrame
             * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns The default type url
             */
            public static getTypeUrl(typeUrlPrefix?: string): string;
        }

        /** Properties of a ModerationAction. */
        interface IModerationAction {

            /** ModerationAction adminId */
            adminId?: (string|null);

            /** ModerationAction targetId */
            targetId?: (string|null);

            /** ModerationAction orgId */
            orgId?: (string|null);

            /** ModerationAction action */
            action?: (specter.v1.ModerationAction.ActionType|null);

            /** ModerationAction reason */
            reason?: (string|null);

            /** ModerationAction targetChannelId */
            targetChannelId?: (string|null);
        }

        /** Represents a ModerationAction. */
        class ModerationAction implements IModerationAction {

            /**
             * Constructs a new ModerationAction.
             * @param [properties] Properties to set
             */
            constructor(properties?: specter.v1.IModerationAction);

            /** ModerationAction adminId. */
            public adminId: string;

            /** ModerationAction targetId. */
            public targetId: string;

            /** ModerationAction orgId. */
            public orgId: string;

            /** ModerationAction action. */
            public action: specter.v1.ModerationAction.ActionType;

            /** ModerationAction reason. */
            public reason: string;

            /** ModerationAction targetChannelId. */
            public targetChannelId: string;

            /**
             * Creates a new ModerationAction instance using the specified properties.
             * @param [properties] Properties to set
             * @returns ModerationAction instance
             */
            public static create(properties?: specter.v1.IModerationAction): specter.v1.ModerationAction;

            /**
             * Encodes the specified ModerationAction message. Does not implicitly {@link specter.v1.ModerationAction.verify|verify} messages.
             * @param message ModerationAction message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encode(message: specter.v1.IModerationAction, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Encodes the specified ModerationAction message, length delimited. Does not implicitly {@link specter.v1.ModerationAction.verify|verify} messages.
             * @param message ModerationAction message or plain object to encode
             * @param [writer] Writer to encode to
             * @returns Writer
             */
            public static encodeDelimited(message: specter.v1.IModerationAction, writer?: $protobuf.Writer): $protobuf.Writer;

            /**
             * Decodes a ModerationAction message from the specified reader or buffer.
             * @param reader Reader or buffer to decode from
             * @param [length] Message length if known beforehand
             * @returns ModerationAction
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decode(reader: ($protobuf.Reader|Uint8Array), length?: number): specter.v1.ModerationAction;

            /**
             * Decodes a ModerationAction message from the specified reader or buffer, length delimited.
             * @param reader Reader or buffer to decode from
             * @returns ModerationAction
             * @throws {Error} If the payload is not a reader or valid buffer
             * @throws {$protobuf.util.ProtocolError} If required fields are missing
             */
            public static decodeDelimited(reader: ($protobuf.Reader|Uint8Array)): specter.v1.ModerationAction;

            /**
             * Verifies a ModerationAction message.
             * @param message Plain object to verify
             * @returns `null` if valid, otherwise the reason why it is not
             */
            public static verify(message: { [k: string]: any }): (string|null);

            /**
             * Creates a ModerationAction message from a plain object. Also converts values to their respective internal types.
             * @param object Plain object
             * @returns ModerationAction
             */
            public static fromObject(object: { [k: string]: any }): specter.v1.ModerationAction;

            /**
             * Creates a plain object from a ModerationAction message. Also converts values to other types if specified.
             * @param message ModerationAction
             * @param [options] Conversion options
             * @returns Plain object
             */
            public static toObject(message: specter.v1.ModerationAction, options?: $protobuf.IConversionOptions): { [k: string]: any };

            /**
             * Converts this ModerationAction to JSON.
             * @returns JSON object
             */
            public toJSON(): { [k: string]: any };

            /**
             * Gets the default type url for ModerationAction
             * @param [typeUrlPrefix] your custom typeUrlPrefix(default "type.googleapis.com")
             * @returns The default type url
             */
            public static getTypeUrl(typeUrlPrefix?: string): string;
        }

        namespace ModerationAction {

            /** ActionType enum. */
            enum ActionType {
                KICK = 0,
                BAN = 1,
                MUTE = 2,
                MOVE = 3
            }
        }
    }
}
