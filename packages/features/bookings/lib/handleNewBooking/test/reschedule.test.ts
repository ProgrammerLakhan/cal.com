import prismaMock from "../../../../../../tests/libs/__mocks__/prisma";

import { describe, expect } from "vitest";

import { appStoreMetadata } from "@calcom/app-store/apps.metadata.generated";
import { WEBAPP_URL } from "@calcom/lib/constants";
import logger from "@calcom/lib/logger";
import { BookingStatus } from "@calcom/prisma/enums";
import { test } from "@calcom/web/test/fixtures/fixtures";
import {
  createBookingScenario,
  getDate,
  getGoogleCalendarCredential,
  TestData,
  getOrganizer,
  getBooker,
  getScenarioData,
  mockSuccessfulVideoMeetingCreation,
  mockCalendarToHaveNoBusySlots,
  mockCalendarToCrashOnUpdateEvent,
  BookingLocations,
  getMockBookingReference,
  getMockBookingAttendee,
} from "@calcom/web/test/utils/bookingScenario/bookingScenario";
import {
  expectWorkflowToBeTriggered,
  expectBookingToBeInDatabase,
  expectBookingRescheduledWebhookToHaveBeenFired,
  expectSuccessfulBookingRescheduledEmails,
  expectSuccessfulCalendarEventUpdationInCalendar,
  expectSuccessfulVideoMeetingUpdationInCalendar,
  expectBookingInDBToBeRescheduledFromTo,
  expectBookingRequestedEmails,
  expectBookingRequestedWebhookToHaveBeenFired,
  expectSuccessfulCalendarEventDeletionInCalendar,
  expectSuccessfulVideoMeetingDeletionInCalendar,
} from "@calcom/web/test/utils/bookingScenario/expects";

import { createMockNextJsRequest } from "./lib/createMockNextJsRequest";
import { getMockRequestDataForBooking } from "./lib/getMockRequestDataForBooking";
import { setupAndTeardown } from "./lib/setupAndTeardown";

// Local test runs sometime gets too slow
const timeout = process.env.CI ? 5000 : 20000;

describe("handleNewBooking", () => {
  setupAndTeardown();

  describe("Reschedule", () => {
    test(
      `should rechedule an existing booking successfully with Cal Video(Daily Video)
          1. Should cancel the existing booking
          2. Should create a new booking in the database
          3. Should send emails to the booker as well as organizer
          4. Should trigger BOOKING_RESCHEDULED webhook
    `,
      async ({ emails }) => {
        const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
        const booker = getBooker({
          email: "booker@example.com",
          name: "Booker",
        });

        const organizer = getOrganizer({
          name: "Organizer",
          email: "organizer@example.com",
          id: 101,
          schedules: [TestData.schedules.IstWorkHours],
          credentials: [getGoogleCalendarCredential()],
          selectedCalendars: [TestData.selectedCalendars.google],
        });

        const { dateString: plus1DateString } = getDate({ dateIncrement: 1 });
        const uidOfBookingToBeRescheduled = "n5Wv3eHgconAED2j4gcVhP";
        await createBookingScenario(
          getScenarioData({
            webhooks: [
              {
                userId: organizer.id,
                eventTriggers: ["BOOKING_CREATED"],
                subscriberUrl: "http://my-webhook.example.com",
                active: true,
                eventTypeId: 1,
                appId: null,
              },
            ],
            eventTypes: [
              {
                id: 1,
                slotInterval: 45,
                length: 45,
                users: [
                  {
                    id: 101,
                  },
                ],
              },
            ],
            bookings: [
              {
                uid: uidOfBookingToBeRescheduled,
                eventTypeId: 1,
                status: BookingStatus.ACCEPTED,
                startTime: `${plus1DateString}T05:00:00.000Z`,
                endTime: `${plus1DateString}T05:15:00.000Z`,
                references: [
                  {
                    type: appStoreMetadata.dailyvideo.type,
                    uid: "MOCK_ID",
                    meetingId: "MOCK_ID",
                    meetingPassword: "MOCK_PASS",
                    meetingUrl: "http://mock-dailyvideo.example.com",
                    credentialId: null,
                  },
                  {
                    type: appStoreMetadata.googlecalendar.type,
                    uid: "MOCK_ID",
                    meetingId: "MOCK_ID",
                    meetingPassword: "MOCK_PASSWORD",
                    meetingUrl: "https://UNUSED_URL",
                    externalCalendarId: "MOCK_EXTERNAL_CALENDAR_ID",
                    credentialId: undefined,
                  },
                ],
              },
            ],
            organizer,
            apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
          })
        );

        const videoMock = mockSuccessfulVideoMeetingCreation({
          metadataLookupKey: "dailyvideo",
        });

        const calendarMock = mockCalendarToHaveNoBusySlots("googlecalendar", {
          create: {
            uid: "MOCK_ID",
          },
          update: {
            uid: "UPDATED_MOCK_ID",
            iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
          },
        });

        const mockBookingData = getMockRequestDataForBooking({
          data: {
            eventTypeId: 1,
            rescheduleUid: uidOfBookingToBeRescheduled,
            start: `${plus1DateString}T04:00:00.000Z`,
            end: `${plus1DateString}T04:15:00.000Z`,
            responses: {
              email: booker.email,
              name: booker.name,
              location: { optionValue: "", value: BookingLocations.CalVideo },
            },
          },
        });

        const { req } = createMockNextJsRequest({
          method: "POST",
          body: mockBookingData,
        });

        const createdBooking = await handleNewBooking(req);

        const previousBooking = await prismaMock.booking.findUnique({
          where: {
            uid: uidOfBookingToBeRescheduled,
          },
        });

        logger.silly({
          previousBooking,
          allBookings: await prismaMock.booking.findMany(),
        });

        // Expect previous booking to be cancelled
        await expectBookingToBeInDatabase({
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          uid: uidOfBookingToBeRescheduled,
          status: BookingStatus.CANCELLED,
        });

        expect(previousBooking?.status).toBe(BookingStatus.CANCELLED);
        /**
         *  Booking Time should be new time
         */
        expect(createdBooking.startTime?.toISOString()).toBe(`${plus1DateString}T04:00:00.000Z`);
        expect(createdBooking.endTime?.toISOString()).toBe(`${plus1DateString}T04:15:00.000Z`);

        await expectBookingInDBToBeRescheduledFromTo({
          from: {
            uid: uidOfBookingToBeRescheduled,
          },
          to: {
            description: "",
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            uid: createdBooking.uid!,
            eventTypeId: mockBookingData.eventTypeId,
            status: BookingStatus.ACCEPTED,
            location: BookingLocations.CalVideo,
            responses: expect.objectContaining({
              email: booker.email,
              name: booker.name,
            }),
            references: [
              {
                type: appStoreMetadata.dailyvideo.type,
                uid: "MOCK_ID",
                meetingId: "MOCK_ID",
                meetingPassword: "MOCK_PASS",
                meetingUrl: "http://mock-dailyvideo.example.com",
              },
              {
                type: appStoreMetadata.googlecalendar.type,
                uid: "MOCK_ID",
                meetingId: "MOCK_ID",
                meetingPassword: "MOCK_PASSWORD",
                meetingUrl: "https://UNUSED_URL",
                externalCalendarId: "MOCK_EXTERNAL_CALENDAR_ID",
              },
            ],
          },
        });

        expectWorkflowToBeTriggered();

        expectSuccessfulVideoMeetingUpdationInCalendar(videoMock, {
          calEvent: {
            location: "http://mock-dailyvideo.example.com",
          },
          bookingRef: {
            type: appStoreMetadata.dailyvideo.type,
            uid: "MOCK_ID",
            meetingId: "MOCK_ID",
            meetingPassword: "MOCK_PASS",
            meetingUrl: "http://mock-dailyvideo.example.com",
          },
        });

        expectSuccessfulCalendarEventUpdationInCalendar(calendarMock, {
          externalCalendarId: "MOCK_EXTERNAL_CALENDAR_ID",
          calEvent: {
            videoCallData: expect.objectContaining({
              url: "http://mock-dailyvideo.example.com",
            }),
          },
          uid: "MOCK_ID",
        });

        expectSuccessfulBookingRescheduledEmails({
          booker,
          organizer,
          emails,
          iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
        });

        expectBookingRescheduledWebhookToHaveBeenFired({
          booker,
          organizer,
          location: BookingLocations.CalVideo,
          subscriberUrl: "http://my-webhook.example.com",
          videoCallUrl: `${WEBAPP_URL}/video/DYNAMIC_UID`,
        });
      },
      timeout
    );

    test(
      `should rechedule a booking successfully and update the event in the same externalCalendarId as was used in the booking earlier.
          1. Should cancel the existing booking
          2. Should create a new booking in the database
          3. Should send emails to the booker as well as organizer
          4. Should trigger BOOKING_RESCHEDULED webhook
    `,
      async ({ emails }) => {
        const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
        const booker = getBooker({
          email: "booker@example.com",
          name: "Booker",
        });

        const organizer = getOrganizer({
          name: "Organizer",
          email: "organizer@example.com",
          id: 101,
          schedules: [TestData.schedules.IstWorkHours],
          credentials: [getGoogleCalendarCredential()],
          selectedCalendars: [TestData.selectedCalendars.google],
        });

        const { dateString: plus1DateString } = getDate({ dateIncrement: 1 });
        const uidOfBookingToBeRescheduled = "n5Wv3eHgconAED2j4gcVhP";
        await createBookingScenario(
          getScenarioData({
            webhooks: [
              {
                userId: organizer.id,
                eventTriggers: ["BOOKING_CREATED"],
                subscriberUrl: "http://my-webhook.example.com",
                active: true,
                eventTypeId: 1,
                appId: null,
              },
            ],
            eventTypes: [
              {
                id: 1,
                slotInterval: 45,
                length: 45,
                users: [
                  {
                    id: 101,
                  },
                ],
                destinationCalendar: {
                  integration: "google_calendar",
                  externalId: "event-type-1@example.com",
                },
              },
            ],
            bookings: [
              {
                uid: uidOfBookingToBeRescheduled,
                eventTypeId: 1,
                status: BookingStatus.ACCEPTED,
                startTime: `${plus1DateString}T05:00:00.000Z`,
                endTime: `${plus1DateString}T05:15:00.000Z`,
                references: [
                  {
                    type: appStoreMetadata.dailyvideo.type,
                    uid: "MOCK_ID",
                    meetingId: "MOCK_ID",
                    meetingPassword: "MOCK_PASS",
                    meetingUrl: "http://mock-dailyvideo.example.com",
                  },
                  {
                    type: appStoreMetadata.googlecalendar.type,
                    uid: "MOCK_ID",
                    meetingId: "MOCK_ID",
                    meetingPassword: "MOCK_PASSWORD",
                    meetingUrl: "https://UNUSED_URL",
                    externalCalendarId: "existing-event-type@example.com",
                    credentialId: undefined,
                  },
                ],
              },
            ],
            organizer,
            apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
          })
        );

        const videoMock = mockSuccessfulVideoMeetingCreation({
          metadataLookupKey: "dailyvideo",
        });

        const calendarMock = mockCalendarToHaveNoBusySlots("googlecalendar", {
          create: {
            uid: "MOCK_ID",
          },
          update: {
            iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
            uid: "UPDATED_MOCK_ID",
          },
        });

        const mockBookingData = getMockRequestDataForBooking({
          data: {
            eventTypeId: 1,
            rescheduleUid: uidOfBookingToBeRescheduled,
            start: `${plus1DateString}T04:00:00.000Z`,
            end: `${plus1DateString}T04:15:00.000Z`,
            responses: {
              email: booker.email,
              name: booker.name,
              location: { optionValue: "", value: BookingLocations.CalVideo },
            },
          },
        });

        const { req } = createMockNextJsRequest({
          method: "POST",
          body: mockBookingData,
        });

        const createdBooking = await handleNewBooking(req);

        /**
         *  Booking Time should be new time
         */
        expect(createdBooking.startTime?.toISOString()).toBe(`${plus1DateString}T04:00:00.000Z`);
        expect(createdBooking.endTime?.toISOString()).toBe(`${plus1DateString}T04:15:00.000Z`);

        await expectBookingInDBToBeRescheduledFromTo({
          from: {
            uid: uidOfBookingToBeRescheduled,
          },
          to: {
            description: "",
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            uid: createdBooking.uid!,
            eventTypeId: mockBookingData.eventTypeId,
            status: BookingStatus.ACCEPTED,
            location: BookingLocations.CalVideo,
            responses: expect.objectContaining({
              email: booker.email,
              name: booker.name,
            }),
            references: [
              {
                type: appStoreMetadata.dailyvideo.type,
                uid: "MOCK_ID",
                meetingId: "MOCK_ID",
                meetingPassword: "MOCK_PASS",
                meetingUrl: "http://mock-dailyvideo.example.com",
              },
              {
                type: appStoreMetadata.googlecalendar.type,
                uid: "MOCK_ID",
                meetingId: "MOCK_ID",
                meetingPassword: "MOCK_PASSWORD",
                meetingUrl: "https://UNUSED_URL",
                externalCalendarId: "existing-event-type@example.com",
              },
            ],
          },
        });

        expectWorkflowToBeTriggered();

        expectSuccessfulVideoMeetingUpdationInCalendar(videoMock, {
          calEvent: {
            location: "http://mock-dailyvideo.example.com",
          },
          bookingRef: {
            type: appStoreMetadata.dailyvideo.type,
            uid: "MOCK_ID",
            meetingId: "MOCK_ID",
            meetingPassword: "MOCK_PASS",
            meetingUrl: "http://mock-dailyvideo.example.com",
          },
        });

        // updateEvent uses existing booking's externalCalendarId to update the event in calendar.
        // and not the event-type's organizer's which is event-type-1@example.com
        expectSuccessfulCalendarEventUpdationInCalendar(calendarMock, {
          externalCalendarId: "existing-event-type@example.com",
          calEvent: {
            location: "http://mock-dailyvideo.example.com",
          },
          uid: "MOCK_ID",
        });

        expectSuccessfulBookingRescheduledEmails({
          booker,
          organizer,
          emails,
          iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
        });
        expectBookingRescheduledWebhookToHaveBeenFired({
          booker,
          organizer,
          location: BookingLocations.CalVideo,
          subscriberUrl: "http://my-webhook.example.com",
          videoCallUrl: `${WEBAPP_URL}/video/DYNAMIC_UID`,
        });
      },
      timeout
    );

    test(
      `an error in updating a calendar event should not stop the rescheduling - Current behaviour is wrong as the booking is resheduled but no-one is notified of it`,
      async ({}) => {
        const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
        const booker = getBooker({
          email: "booker@example.com",
          name: "Booker",
        });

        const organizer = getOrganizer({
          name: "Organizer",
          email: "organizer@example.com",
          id: 101,
          schedules: [TestData.schedules.IstWorkHours],
          credentials: [getGoogleCalendarCredential()],
          selectedCalendars: [TestData.selectedCalendars.google],
          destinationCalendar: {
            integration: "google_calendar",
            externalId: "organizer@google-calendar.com",
          },
        });
        const uidOfBookingToBeRescheduled = "n5Wv3eHgconAED2j4gcVhP";
        const { dateString: plus1DateString } = getDate({ dateIncrement: 1 });

        await createBookingScenario(
          getScenarioData({
            webhooks: [
              {
                userId: organizer.id,
                eventTriggers: ["BOOKING_CREATED"],
                subscriberUrl: "http://my-webhook.example.com",
                active: true,
                eventTypeId: 1,
                appId: null,
              },
            ],
            eventTypes: [
              {
                id: 1,
                slotInterval: 45,
                length: 45,
                users: [
                  {
                    id: 101,
                  },
                ],
              },
            ],
            bookings: [
              {
                uid: uidOfBookingToBeRescheduled,
                eventTypeId: 1,
                status: BookingStatus.ACCEPTED,
                startTime: `${plus1DateString}T05:00:00.000Z`,
                endTime: `${plus1DateString}T05:15:00.000Z`,
                references: [
                  {
                    type: appStoreMetadata.dailyvideo.type,
                    uid: "MOCK_ID",
                    meetingId: "MOCK_ID",
                    meetingPassword: "MOCK_PASS",
                    meetingUrl: "http://mock-dailyvideo.example.com",
                  },
                  {
                    type: appStoreMetadata.googlecalendar.type,
                    uid: "ORIGINAL_BOOKING_UID",
                    meetingId: "ORIGINAL_MEETING_ID",
                    meetingPassword: "ORIGINAL_MEETING_PASSWORD",
                    meetingUrl: "https://ORIGINAL_MEETING_URL",
                    externalCalendarId: "existing-event-type@example.com",
                    credentialId: undefined,
                  },
                ],
              },
            ],
            organizer,
            apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
          })
        );

        const _calendarMock = mockCalendarToCrashOnUpdateEvent("googlecalendar");

        const mockBookingData = getMockRequestDataForBooking({
          data: {
            eventTypeId: 1,
            rescheduleUid: uidOfBookingToBeRescheduled,
            responses: {
              email: booker.email,
              name: booker.name,
              location: { optionValue: "", value: "New York" },
            },
          },
        });

        const { req } = createMockNextJsRequest({
          method: "POST",
          body: mockBookingData,
        });

        const createdBooking = await handleNewBooking(req);

        await expectBookingInDBToBeRescheduledFromTo({
          from: {
            uid: uidOfBookingToBeRescheduled,
          },
          to: {
            description: "",
            location: "New York",
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            uid: createdBooking.uid!,
            eventTypeId: mockBookingData.eventTypeId,
            status: BookingStatus.ACCEPTED,
            responses: expect.objectContaining({
              email: booker.email,
              name: booker.name,
            }),
            references: [
              {
                type: appStoreMetadata.googlecalendar.type,
                // A reference is still created in case of event creation failure, with nullish values. Not sure what's the purpose for this.
                uid: "ORIGINAL_BOOKING_UID",
                meetingId: "ORIGINAL_MEETING_ID",
                meetingPassword: "ORIGINAL_MEETING_PASSWORD",
                meetingUrl: "https://ORIGINAL_MEETING_URL",
              },
            ],
          },
        });

        expectWorkflowToBeTriggered();

        // FIXME: We should send Broken Integration emails on calendar event updation failure
        // expectBrokenIntegrationEmails({ booker, organizer, emails });

        expectBookingRescheduledWebhookToHaveBeenFired({
          booker,
          organizer,
          location: "New York",
          subscriberUrl: "http://my-webhook.example.com",
        });
      },
      timeout
    );

    describe("Event Type that requires confirmation", () => {
      test(
        `should reschedule a booking that requires confirmation in PENDING state - When a booker(who is not the organizer himself) is doing the schedule
          1. Should cancel the existing booking
          2. Should delete existing calendar invite and Video meeting
          2. Should create a new booking in the database in PENDING state
          3. Should send BOOKING Requested scenario emails to the booker as well as organizer
          4. Should trigger BOOKING_REQUESTED webhook instead of BOOKING_RESCHEDULED
    `,
        async ({ emails }) => {
          const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
          const subscriberUrl = "http://my-webhook.example.com";
          const booker = getBooker({
            email: "booker@example.com",
            name: "Booker",
          });

          const organizer = getOrganizer({
            name: "Organizer",
            email: "organizer@example.com",
            id: 101,
            schedules: [TestData.schedules.IstWorkHours],
            credentials: [getGoogleCalendarCredential()],
            selectedCalendars: [TestData.selectedCalendars.google],
          });
          const { dateString: plus1DateString } = getDate({ dateIncrement: 1 });
          const uidOfBookingToBeRescheduled = "n5Wv3eHgconAED2j4gcVhP";

          const scenarioData = getScenarioData({
            webhooks: [
              {
                userId: organizer.id,
                eventTriggers: ["BOOKING_CREATED"],
                subscriberUrl,
                active: true,
                eventTypeId: 1,
                appId: null,
              },
            ],
            eventTypes: [
              {
                id: 1,
                slotInterval: 45,
                requiresConfirmation: true,
                length: 45,
                users: [
                  {
                    id: 101,
                  },
                ],
              },
            ],
            bookings: [
              {
                uid: uidOfBookingToBeRescheduled,
                eventTypeId: 1,
                status: BookingStatus.ACCEPTED,
                startTime: `${plus1DateString}T05:00:00.000Z`,
                endTime: `${plus1DateString}T05:15:00.000Z`,
                references: [
                  getMockBookingReference({
                    type: appStoreMetadata.dailyvideo.type,
                    uid: "MOCK_ID",
                    meetingId: "MOCK_ID",
                    meetingPassword: "MOCK_PASS",
                    meetingUrl: "http://mock-dailyvideo.example.com",
                    credentialId: 0,
                  }),
                  getMockBookingReference({
                    type: appStoreMetadata.googlecalendar.type,
                    uid: "MOCK_ID",
                    meetingId: "MOCK_ID",
                    meetingPassword: "MOCK_PASSWORD",
                    meetingUrl: "https://UNUSED_URL",
                    externalCalendarId: "MOCK_EXTERNAL_CALENDAR_ID",
                    credentialId: 1,
                  }),
                ],
              },
            ],
            organizer,
            apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
          });
          await createBookingScenario(scenarioData);

          const videoMock = mockSuccessfulVideoMeetingCreation({
            metadataLookupKey: "dailyvideo",
          });

          const calendarMock = mockCalendarToHaveNoBusySlots("googlecalendar", {
            create: {
              uid: "MOCK_ID",
            },
            update: {
              uid: "UPDATED_MOCK_ID",
              iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
            },
          });

          const mockBookingData = getMockRequestDataForBooking({
            data: {
              eventTypeId: 1,
              rescheduleUid: uidOfBookingToBeRescheduled,
              start: `${plus1DateString}T04:00:00.000Z`,
              end: `${plus1DateString}T04:15:00.000Z`,
              responses: {
                email: booker.email,
                name: booker.name,
                location: { optionValue: "", value: BookingLocations.CalVideo },
              },
            },
          });

          const { req } = createMockNextJsRequest({
            method: "POST",
            body: mockBookingData,
          });

          const createdBooking = await handleNewBooking(req);
          expect(createdBooking.responses).toContain({
            email: booker.email,
            name: booker.name,
          });

          await expectBookingInDBToBeRescheduledFromTo({
            from: {
              uid: uidOfBookingToBeRescheduled,
            },
            to: {
              description: "",
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              uid: createdBooking.uid!,
              eventTypeId: mockBookingData.eventTypeId,
              // Rescheduled booking sill stays in pending state
              status: BookingStatus.PENDING,
              location: BookingLocations.CalVideo,
              responses: expect.objectContaining({
                email: booker.email,
                name: booker.name,
              }),
              references: [
                {
                  type: appStoreMetadata.dailyvideo.type,
                  uid: "MOCK_ID",
                  meetingId: "MOCK_ID",
                  meetingPassword: "MOCK_PASS",
                  meetingUrl: "http://mock-dailyvideo.example.com",
                },
                {
                  type: appStoreMetadata.googlecalendar.type,
                  uid: "MOCK_ID",
                  meetingId: "MOCK_ID",
                  meetingPassword: "MOCK_PASSWORD",
                  meetingUrl: "https://UNUSED_URL",
                  externalCalendarId: "MOCK_EXTERNAL_CALENDAR_ID",
                },
              ],
            },
          });

          expectWorkflowToBeTriggered();

          expectBookingRequestedEmails({
            booker,
            organizer,
            emails,
          });

          expectBookingRequestedWebhookToHaveBeenFired({
            booker,
            organizer,
            location: BookingLocations.CalVideo,
            subscriberUrl,
            eventType: scenarioData.eventTypes[0],
          });

          expectSuccessfulVideoMeetingDeletionInCalendar(videoMock, {
            bookingRef: {
              type: appStoreMetadata.dailyvideo.type,
              uid: "MOCK_ID",
              meetingId: "MOCK_ID",
              meetingPassword: "MOCK_PASS",
              meetingUrl: "http://mock-dailyvideo.example.com",
            },
          });

          expectSuccessfulCalendarEventDeletionInCalendar(calendarMock, {
            externalCalendarId: "MOCK_EXTERNAL_CALENDAR_ID",
            calEvent: {
              videoCallData: expect.objectContaining({
                url: "http://mock-dailyvideo.example.com",
              }),
            },
            uid: "MOCK_ID",
          });
        },
        timeout
      );

      // eslint-disable-next-line playwright/no-skipped-test
      test.skip(
        `should rechedule a booking, that requires confirmation, without confirmation - When Organizer is doing the reschedule
          1. Should cancel the existing booking
          2. Should delete existing calendar invite and Video meeting
          2. Should create a new booking in the database in ACCEPTED state
          3. Should send rescheduled emails to the booker as well as organizer
          4. Should trigger BOOKING_RESCHEDULED webhook
    `,
        async ({ emails }) => {
          const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
          const booker = getBooker({
            email: "booker@example.com",
            name: "Booker",
          });

          const organizer = getOrganizer({
            name: "Organizer",
            email: "organizer@example.com",
            id: 101,
            schedules: [TestData.schedules.IstWorkHours],
            credentials: [getGoogleCalendarCredential()],
            selectedCalendars: [TestData.selectedCalendars.google],
          });

          const { dateString: plus1DateString } = getDate({ dateIncrement: 1 });
          const uidOfBookingToBeRescheduled = "n5Wv3eHgconAED2j4gcVhP";
          await createBookingScenario(
            getScenarioData({
              webhooks: [
                {
                  userId: organizer.id,
                  eventTriggers: ["BOOKING_CREATED"],
                  subscriberUrl: "http://my-webhook.example.com",
                  active: true,
                  eventTypeId: 1,
                  appId: null,
                },
              ],
              eventTypes: [
                {
                  id: 1,
                  requiresConfirmation: true,
                  slotInterval: 45,
                  length: 45,
                  users: [
                    {
                      id: 101,
                    },
                  ],
                  destinationCalendar: {
                    integration: "google_calendar",
                    externalId: "event-type-1@example.com",
                  },
                },
              ],
              bookings: [
                {
                  uid: uidOfBookingToBeRescheduled,
                  eventTypeId: 1,
                  status: BookingStatus.ACCEPTED,
                  startTime: `${plus1DateString}T05:00:00.000Z`,
                  endTime: `${plus1DateString}T05:15:00.000Z`,
                  references: [
                    {
                      type: appStoreMetadata.dailyvideo.type,
                      uid: "MOCK_ID",
                      meetingId: "MOCK_ID",
                      meetingPassword: "MOCK_PASS",
                      meetingUrl: "http://mock-dailyvideo.example.com",
                    },
                    {
                      type: appStoreMetadata.googlecalendar.type,
                      uid: "MOCK_ID",
                      meetingId: "MOCK_ID",
                      meetingPassword: "MOCK_PASSWORD",
                      meetingUrl: "https://UNUSED_URL",
                      externalCalendarId: "existing-event-type@example.com",
                      credentialId: undefined,
                    },
                  ],
                  attendees: [
                    getMockBookingAttendee({
                      id: 1,
                      name: organizer.name,
                      email: organizer.email,
                      locale: "en",
                      timeZone: "Europe/London",
                    }),
                    getMockBookingAttendee({
                      id: 2,
                      name: booker.name,
                      email: booker.email,
                      // Booker's locale when the fresh booking happened earlier
                      locale: "hi",
                      // Booker's timezone when the fresh booking happened earlier
                      timeZone: "Asia/Kolkata",
                    }),
                  ],
                },
              ],
              organizer,
              apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
            })
          );

          const videoMock = mockSuccessfulVideoMeetingCreation({
            metadataLookupKey: "dailyvideo",
          });

          const calendarMock = mockCalendarToHaveNoBusySlots("googlecalendar", {
            create: {
              uid: "MOCK_ID",
            },
            update: {
              iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
              uid: "UPDATED_MOCK_ID",
            },
          });

          const mockBookingData = getMockRequestDataForBooking({
            data: {
              eventTypeId: 1,
              rescheduleUid: uidOfBookingToBeRescheduled,
              start: `${plus1DateString}T04:00:00.000Z`,
              end: `${plus1DateString}T04:15:00.000Z`,
              // Organizer is doing the rescheduling from his timezone which is different from Booker Timezone as per the booking being rescheduled
              timeZone: "Europe/London",
              responses: {
                email: booker.email,
                name: booker.name,
                location: { optionValue: "", value: BookingLocations.CalVideo },
              },
            },
          });

          const { req } = createMockNextJsRequest({
            method: "POST",
            body: mockBookingData,
          });

          // Fake the request to be from organizer
          req.userId = organizer.id;

          const createdBooking = await handleNewBooking(req);

          /**
           *  Booking Time should be new time
           */
          expect(createdBooking.startTime?.toISOString()).toBe(`${plus1DateString}T04:00:00.000Z`);
          expect(createdBooking.endTime?.toISOString()).toBe(`${plus1DateString}T04:15:00.000Z`);

          await expectBookingInDBToBeRescheduledFromTo({
            from: {
              uid: uidOfBookingToBeRescheduled,
            },
            to: {
              description: "",
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              uid: createdBooking.uid!,
              eventTypeId: mockBookingData.eventTypeId,
              status: BookingStatus.ACCEPTED,
              location: BookingLocations.CalVideo,
              responses: expect.objectContaining({
                email: booker.email,
                name: booker.name,
              }),
              references: [
                {
                  type: appStoreMetadata.dailyvideo.type,
                  uid: "MOCK_ID",
                  meetingId: "MOCK_ID",
                  meetingPassword: "MOCK_PASS",
                  meetingUrl: "http://mock-dailyvideo.example.com",
                },
                {
                  type: appStoreMetadata.googlecalendar.type,
                  uid: "MOCK_ID",
                  meetingId: "MOCK_ID",
                  meetingPassword: "MOCK_PASSWORD",
                  meetingUrl: "https://UNUSED_URL",
                  externalCalendarId: "existing-event-type@example.com",
                },
              ],
            },
          });

          expectWorkflowToBeTriggered();

          expectSuccessfulVideoMeetingUpdationInCalendar(videoMock, {
            calEvent: {
              location: "http://mock-dailyvideo.example.com",
            },
            bookingRef: {
              type: appStoreMetadata.dailyvideo.type,
              uid: "MOCK_ID",
              meetingId: "MOCK_ID",
              meetingPassword: "MOCK_PASS",
              meetingUrl: "http://mock-dailyvideo.example.com",
            },
          });

          // updateEvent uses existing booking's externalCalendarId to update the event in calendar.
          // and not the event-type's organizer's which is event-type-1@example.com
          expectSuccessfulCalendarEventUpdationInCalendar(calendarMock, {
            externalCalendarId: "existing-event-type@example.com",
            calEvent: {
              location: "http://mock-dailyvideo.example.com",
              attendees: expect.arrayContaining([
                expect.objectContaining({
                  email: booker.email,
                  name: booker.name,
                  // Expect that the booker timezone is his earlier timezone(from original booking), even though the rescheduling is done by organizer from his timezone
                  timeZone: "Asia/Kolkata",
                  language: expect.objectContaining({
                    // Expect that the booker locale is his earlier locale(from original booking), even though the rescheduling is done by organizer with his locale
                    locale: "hi",
                  }),
                }),
              ]),
            },
            uid: "MOCK_ID",
          });

          expectSuccessfulBookingRescheduledEmails({
            booker,
            organizer,
            emails,
            iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
          });
          expectBookingRescheduledWebhookToHaveBeenFired({
            booker,
            organizer,
            location: BookingLocations.CalVideo,
            subscriberUrl: "http://my-webhook.example.com",
            videoCallUrl: `${WEBAPP_URL}/video/DYNAMIC_UID`,
          });
        },
        timeout
      );

      // eslint-disable-next-line playwright/no-skipped-test
      test.skip(
        `should rechedule a booking, that requires confirmation, without confirmation - When the owner of the previous booking is doing the reschedule
          1. Should cancel the existing booking
          2. Should delete existing calendar invite and Video meeting
          2. Should create a new booking in the database in ACCEPTED state
          3. Should send rescheduled emails to the booker as well as organizer
          4. Should trigger BOOKING_RESCHEDULED webhook
    `,
        async ({ emails }) => {
          const handleNewBooking = (await import("@calcom/features/bookings/lib/handleNewBooking")).default;
          const booker = getBooker({
            email: "booker@example.com",
            name: "Booker",
          });

          const organizer = getOrganizer({
            name: "Organizer",
            email: "organizer@example.com",
            id: 101,
            schedules: [TestData.schedules.IstWorkHours],
            credentials: [getGoogleCalendarCredential()],
            selectedCalendars: [TestData.selectedCalendars.google],
          });

          const { dateString: plus1DateString } = getDate({ dateIncrement: 1 });
          const uidOfBookingToBeRescheduled = "n5Wv3eHgconAED2j4gcVhP";
          const previousOrganizerIdForTheBooking = 1001;
          await createBookingScenario(
            getScenarioData({
              webhooks: [
                {
                  userId: organizer.id,
                  eventTriggers: ["BOOKING_CREATED"],
                  subscriberUrl: "http://my-webhook.example.com",
                  active: true,
                  eventTypeId: 1,
                  appId: null,
                },
              ],
              eventTypes: [
                {
                  id: 1,
                  requiresConfirmation: true,
                  slotInterval: 45,
                  length: 45,
                  users: [
                    {
                      id: 101,
                    },
                  ],
                  destinationCalendar: {
                    integration: "google_calendar",
                    externalId: "event-type-1@example.com",
                  },
                },
              ],
              bookings: [
                {
                  uid: uidOfBookingToBeRescheduled,
                  eventTypeId: 1,
                  // Make sure that the earlier booking owner is some user with ID 10001
                  userId: previousOrganizerIdForTheBooking,
                  status: BookingStatus.ACCEPTED,
                  startTime: `${plus1DateString}T05:00:00.000Z`,
                  endTime: `${plus1DateString}T05:15:00.000Z`,
                  references: [
                    {
                      type: appStoreMetadata.dailyvideo.type,
                      uid: "MOCK_ID",
                      meetingId: "MOCK_ID",
                      meetingPassword: "MOCK_PASS",
                      meetingUrl: "http://mock-dailyvideo.example.com",
                    },
                    {
                      type: appStoreMetadata.googlecalendar.type,
                      uid: "MOCK_ID",
                      meetingId: "MOCK_ID",
                      meetingPassword: "MOCK_PASSWORD",
                      meetingUrl: "https://UNUSED_URL",
                      externalCalendarId: "existing-event-type@example.com",
                      credentialId: undefined,
                    },
                  ],
                  attendees: [
                    getMockBookingAttendee({
                      id: 1,
                      name: organizer.name,
                      email: organizer.email,
                      locale: "en",
                      timeZone: "Europe/London",
                    }),
                    getMockBookingAttendee({
                      id: 2,
                      name: booker.name,
                      email: booker.email,
                      // Booker's locale when the fresh booking happened earlier
                      locale: "hi",
                      // Booker's timezone when the fresh booking happened earlier
                      timeZone: "Asia/Kolkata",
                    }),
                  ],
                },
              ],
              organizer,
              usersApartFromOrganizer: [
                {
                  id: previousOrganizerIdForTheBooking,
                  name: "Previous Organizer",
                  username: "prev-organizer",
                  email: "",
                  schedules: [TestData.schedules.IstWorkHours],
                  timeZone: "Europe/London",
                },
              ],
              apps: [TestData.apps["google-calendar"], TestData.apps["daily-video"]],
            })
          );

          const videoMock = mockSuccessfulVideoMeetingCreation({
            metadataLookupKey: "dailyvideo",
          });

          const calendarMock = mockCalendarToHaveNoBusySlots("googlecalendar", {
            create: {
              uid: "MOCK_ID",
            },
            update: {
              iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
              uid: "UPDATED_MOCK_ID",
            },
          });

          const mockBookingData = getMockRequestDataForBooking({
            data: {
              eventTypeId: 1,
              rescheduleUid: uidOfBookingToBeRescheduled,
              start: `${plus1DateString}T04:00:00.000Z`,
              end: `${plus1DateString}T04:15:00.000Z`,
              // Organizer is doing the rescheduling from his timezone which is different from Booker Timezone as per the booking being rescheduled
              timeZone: "Europe/London",
              responses: {
                email: booker.email,
                name: booker.name,
                location: { optionValue: "", value: BookingLocations.CalVideo },
              },
            },
          });

          const { req } = createMockNextJsRequest({
            method: "POST",
            body: mockBookingData,
          });

          // Fake the request to be from organizer
          req.userId = previousOrganizerIdForTheBooking;

          const createdBooking = await handleNewBooking(req);

          /**
           *  Booking Time should be new time
           */
          expect(createdBooking.startTime?.toISOString()).toBe(`${plus1DateString}T04:00:00.000Z`);
          expect(createdBooking.endTime?.toISOString()).toBe(`${plus1DateString}T04:15:00.000Z`);

          await expectBookingInDBToBeRescheduledFromTo({
            from: {
              uid: uidOfBookingToBeRescheduled,
            },
            to: {
              description: "",
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              uid: createdBooking.uid!,
              eventTypeId: mockBookingData.eventTypeId,
              status: BookingStatus.ACCEPTED,
              location: BookingLocations.CalVideo,
              responses: expect.objectContaining({
                email: booker.email,
                name: booker.name,
              }),
              references: [
                {
                  type: appStoreMetadata.dailyvideo.type,
                  uid: "MOCK_ID",
                  meetingId: "MOCK_ID",
                  meetingPassword: "MOCK_PASS",
                  meetingUrl: "http://mock-dailyvideo.example.com",
                },
                {
                  type: appStoreMetadata.googlecalendar.type,
                  uid: "MOCK_ID",
                  meetingId: "MOCK_ID",
                  meetingPassword: "MOCK_PASSWORD",
                  meetingUrl: "https://UNUSED_URL",
                  externalCalendarId: "existing-event-type@example.com",
                },
              ],
            },
          });

          expectWorkflowToBeTriggered();

          expectSuccessfulVideoMeetingUpdationInCalendar(videoMock, {
            calEvent: {
              location: "http://mock-dailyvideo.example.com",
            },
            bookingRef: {
              type: appStoreMetadata.dailyvideo.type,
              uid: "MOCK_ID",
              meetingId: "MOCK_ID",
              meetingPassword: "MOCK_PASS",
              meetingUrl: "http://mock-dailyvideo.example.com",
            },
          });

          // updateEvent uses existing booking's externalCalendarId to update the event in calendar.
          // and not the event-type's organizer's which is event-type-1@example.com
          expectSuccessfulCalendarEventUpdationInCalendar(calendarMock, {
            externalCalendarId: "existing-event-type@example.com",
            calEvent: {
              location: "http://mock-dailyvideo.example.com",
              attendees: expect.arrayContaining([
                expect.objectContaining({
                  email: booker.email,
                  name: booker.name,
                  // Expect that the booker timezone is his earlier timezone(from original booking), even though the rescheduling is done by organizer from his timezone
                  timeZone: "Asia/Kolkata",
                  language: expect.objectContaining({
                    // Expect that the booker locale is his earlier locale(from original booking), even though the rescheduling is done by organizer with his locale
                    locale: "hi",
                  }),
                }),
              ]),
            },
            uid: "MOCK_ID",
          });

          expectSuccessfulBookingRescheduledEmails({
            booker,
            organizer,
            emails,
            iCalUID: "MOCKED_GOOGLE_CALENDAR_ICS_ID",
          });
          expectBookingRescheduledWebhookToHaveBeenFired({
            booker,
            organizer,
            location: BookingLocations.CalVideo,
            subscriberUrl: "http://my-webhook.example.com",
            videoCallUrl: `${WEBAPP_URL}/video/DYNAMIC_UID`,
          });
        },
        timeout
      );
    });
  });
});
