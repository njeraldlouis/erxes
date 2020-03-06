import gql from 'graphql-tag';
import * as compose from 'lodash.flowright';
import EmptyState from 'modules/common/components/EmptyState';
import { IRouterProps } from 'modules/common/types';
import { router as routerUtils, withProps } from 'modules/common/utils';
import React, { useEffect } from 'react';
import { graphql } from 'react-apollo';
import { withRouter } from 'react-router';
import { queries } from '../graphql';
import { IOptions, PipelineDetailQueryResponse } from '../types';

type Props = {
  queryParams: any;
  options: IOptions;
};

type ContainerProps = {
  pipelineDetailQuery: PipelineDetailQueryResponse;
} & IRouterProps &
  Props;

const withPipeline = Component => {
  const Container = (props: ContainerProps) => {
    const { pipelineDetailQuery, history, options } = props;

    useEffect(() => {
      return pipelineDetailQuery.subscribeToMore({
        document: gql(options.subscriptions.moveSubscription),
        updateQuery: () => {
          routerUtils.setParams(history, { key: Math.random() });
          // location.reload();
        }
      });
    });

    const pipeline = pipelineDetailQuery && pipelineDetailQuery.pipelineDetail;

    if (!pipeline) {
      return (
        <EmptyState
          image="/images/actions/18.svg"
          text="Oh boy, looks like you need to get a head start on your board"
          size="small"
          light={true}
        />
      );
    }

    const updatedProps = {
      ...props,
      pipeline: pipelineDetailQuery.pipelineDetail
    };

    return <Component {...updatedProps} />;
  };

  return withProps<Props>(
    compose(
      graphql<Props, PipelineDetailQueryResponse, { _id?: string }>(
        gql(queries.pipelineDetail),
        {
          name: 'pipelineDetailQuery',
          skip: ({ queryParams }) => !queryParams.pipelineId,
          options: ({ queryParams }) => ({
            variables: { _id: queryParams && queryParams.pipelineId }
          })
        }
      )
    )(withRouter(Container))
  );
};

export default withPipeline;
